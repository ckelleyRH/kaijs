/* This file is part of kaijs

 * Copyright (c) 2021, 2022, 2023 Andrei Stepanov <astepano@redhat.com>
 * 
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 * 
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

import _ from 'lodash';
import Joi from 'joi';
import debug from 'debug';
import cron from 'node-cron';

import {
  fqueue as fq,
  FileQueueCallback,
  FileQueueEntry,
  FileQueueMessage,
} from './fqueue';
import { getcfg, mkDirParents } from './cfg';
import { getAllSchemas } from './get_schema';

import {
  getMsgUpserts,
  OpensearchClient,
  printify,
  Upsert,
} from './opensearch/opensearch';

import { schemas } from './validation';
import { OrderedBulkOperation } from 'mongodb';

/** Wire-in pino and debug togather. */
require('./pino_logger');

const log = debug('kaijs:loader_opensearch');
const cfg = getcfg();
/** absolute path to present dump dir */
var file_queue_path: string;
const file_queue_path_cfg = cfg.loader.file_queue_path;
/** absolute path to present dump dir */
var file_queue_path: string;
var fqueue: any;

/**
 * There are two messages types:
 * 1) msg from file-queue from listener. Variable prefix: fq_ or file_queue_
 * 2) msg from amqp-broker: Variable prefix: broker_
 */

async function handle_signal(
  fqueue: any,
  opensearchClient: OpensearchClient,
  signal: NodeJS.Signals,
): Promise<void> {
  log(`Received: ${signal}. Closing connection to filequeue and db.`);
  /*
   * Initiate graceful closing.
   */
  log(' [i] Stop monitoring the file queue directories');
  fqueue.stop();
  log(' [i] Close the db and its underlying connections');
  opensearchClient.close();
  log('Clean exit');
  process.exit(0);
}

async function start(): Promise<never> {
  file_queue_path = mkDirParents(file_queue_path_cfg);
  log('File-queue path: %s', file_queue_path);
  fqueue = await fq.make(file_queue_path, { poll: true, optimizeList: true });
  log('File-queue length at start: %s', await fq.length(fqueue));
  var opensearchClient: OpensearchClient;
  try {
    opensearchClient = new OpensearchClient();
    await opensearchClient.init();
  } catch (error) {
    console.warn('Whoops! Cannot init opensearch.', error);
    process.exit(1);
  }
  const clean_on: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGABRT'];
  for (const signal of clean_on) {
    process.once(signal, _.curry(handle_signal)(fqueue, opensearchClient));
  }
  /** Do not process messages until we have local copy of the git-repo with messages schemas */
  await getAllSchemas();
  /**
   * Update schemas each 12 hours:
   */
  const cronExprShemas = '2 */12 * * *';
  log(
    ' [i] schedule cron task to update schemas. Cron cfg: %s',
    cronExprShemas,
  );
  cron.schedule(cronExprShemas, getAllSchemas);

  /**
   * The encodeURI() function replaces each non-ASCII character in the string with a percent-encoded representation,
   * which is a sequence of three characters. By splitting the encoded string on these sequences and counting the resulting
   * array length, we can determine the number of bytes in the original string.
   */
  function getObjectSize(obj: any): number {
    const objectString = JSON.stringify(obj);
    const utf8Length = encodeURI(objectString).split(/%..|./).length - 1;
    return utf8Length;
  }

  function rollbackFqMessages(fqEntries: FileQueueEntry[]) {
    for (let fq_entry of fqEntries) {
      log(
        ' [i] Make file-queue item again available for popping. Broker msg-id: %s.',
        fq_entry.message.broker_msg_id,
      );
      fq_entry.rollback((err: Error) => {
        if (err) throw err;
      });
    }
  }

  function commitFqMessages(fqEntries: FileQueueEntry[]) {
    for (let fq_entry of fqEntries) {
      /**
       * Message was processed. Release message from file-queue.
       */
      log(
        ' [i] Message was processed. Broker msg-id %s.',
        fq_entry.message.broker_msg_id,
      );
      fq_entry.commit((err: Error) => {
        if (err) throw err;
      });
    }
  }

  let fqEntries: FileQueueEntry[] = [];
  let bulkUpserts: Upsert[] = [];
  let bulkSizeBytes = 0;
  let prevMsgTime = new Date();
  const bulkSecondsThreshold = 3;
  const bulkMaxEntries = 100;
  /** 50MB: bulk max size, to pass HTTPS request + 1 message in size 50MB. */
  const bulkMaxSize = 1024 * 1024 * 1024 * 50;

  while (true) {
    let fq_msg: FileQueueMessage;
    let fq_commit: FileQueueCallback, fq_rollback: FileQueueCallback;
    let fq_entry: FileQueueEntry;
    try {
      log(' [i] Waiting for next fq message...');
      fq_entry = await fq.tpop(fqueue);
      [fq_msg, fq_commit, fq_rollback] = [
        fq_entry.message,
        fq_entry.commit,
        fq_entry.rollback,
      ];
    } catch (err) {
      console.warn('Cannot get msg from file-queue', err);
      process.exit(1);
    }
    const parse_err = _.attempt(Joi.assert, fq_msg, schemas['fq_msg'], {
      allowUnknown: true,
    });
    if (_.isError(parse_err)) {
      fq_commit((err: Error) => {
        if (err) throw err;
      });
      log(
        ' [E] Cannot parse received message from file-queue. Dropping message:%s%s',
        '\n',
        parse_err.message,
      );
      continue;
    }
    log(
      ' [i] Adding message to DB with file-queue message id %O.',
      fq_msg.fq_msg_id,
    );
    const newMsgTime = new Date();
    const secondsBetweenMessages =
      (newMsgTime.getTime() - prevMsgTime.getTime()) / 1000;
    prevMsgTime = newMsgTime;
    const msgUpserts = await getMsgUpserts(fq_msg);
    const upsertsSizeBytes = _.sum(
      _.map(msgUpserts, (upsert) => getObjectSize(upsert.upsertDoc)),
    );
    bulkSizeBytes += upsertsSizeBytes;
    bulkUpserts = [...bulkUpserts, ...msgUpserts];
    fqEntries.push(fq_entry);
    if (
      secondsBetweenMessages < bulkSecondsThreshold &&
      bulkUpserts.length < bulkMaxEntries &&
      bulkSizeBytes < bulkMaxSize
    ) {
      continue;
    }
    log(' [I] bulkSizeBytes: %s', bulkSizeBytes);
    try {
      await opensearchClient.bulkUpdate(bulkUpserts);
      bulkUpserts = [];
      bulkSizeBytes = 0;
      commitFqMessages(fqEntries);
      fqEntries = [];
    } catch (err) {
      if (_.isError(err)) {
        /** err object can have many different properties. To dump all details abot err we use printify */
        log(
          ' [E] Cannot update DB with received messages.',
          'Error is:',
          printify(err),
        );
      } else {
        throw err;
      }
      rollbackFqMessages(fqEntries);
      /**
       * Exit from programm.
       */
      process.exit(1);
    }
  }
}

start().catch((error) => {
  console.warn(error);
  process.exit(1);
});
