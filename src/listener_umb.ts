/*
 * This file is part of kaijs

 * Copyright (c) 2021 Andrei Stepanov <astepano@redhat.com>
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

import fs from 'fs';
import _ from 'lodash';
import assert from 'assert';
import debug from 'debug';
import crypto from 'crypto';
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import {
  types,
  Session,
  Message,
  message,
  Receiver,
  Delivery,
  AmqpError,
  TypeError,
  Connection,
  isAmqpError,
  EventContext,
  SessionEvents,
  ProtocolError,
  ReceiverEvents,
  ConnectionError,
  ReceiverOptions,
  ConnectionEvents,
  ConnectionOptions,
} from 'rhea-promise';

import { fqueue as fq } from './fqueue';
import { getcfg, mkDirParents } from './cfg';
import { ConnectionDetails } from 'rhea';
const listener_name = 'kaijs-listener-umb';
/** Wire-in pino and debug togather. */
require('./pino_logger');

const log = debug('kaijs:listener-umb');
const cfg = getcfg();
const broker_cfg = cfg.listener.broker_umb;
const topics_cfg = cfg.listener.broker_umb.topics.set;
const file_queue_path_cfg = cfg.listener.file_queue_path;
log('Active config: %s, %O', '\n', cfg.listener.broker_umb);
/** absolute path to present dump dir */
var file_queue_path: string;
var fqueue: any;
var attempt = 0;
var processed = 0;
const client_name = broker_cfg.client_name;
/**
 * Keep the same subscription_id during retries and reconnections.
 */
const subscription_id = broker_cfg.subscription_id || uuidv4();
var links: Set<Receiver> = new Set();

/*
 * We use AMQP 1.0 protocol.
 * Library rhea implements AMQP 1.0 :
 *
 * https://www.npmjs.com/package/rhea-promise
 * https://github.com/amqp/rhea-promise
 *
 * 1 Container can have 1..* Connections.
 * 1 Connection can have 1..* Sessions.
 * 1 Session can have 1..* Links.
 * A Link can have the role of Receiver or Sender.
 *
 * For VirtualTopic: The presence of the queue acts as the subscription.
 *
 * Queues vs. Topics vs. Virtual Topics (in ActiveMQ):
 * https://tuhrig.de/queues-vs-topics-vs-virtual-topics-in-activemq/
 * https://www.youtube.com/watch?v=ODpeIdUdClc
 * http://docs.oasis-open.org/amqp/core/v1.0/amqp-core-complete-v1.0.pdf
 * https://stackoverflow.com/questions/60395765/what-is-the-difference-between-channels-and-links-in-amqp
 *
 */

const status = async (
  links: Set<Receiver>,
  connection: Connection
): Promise<void> => {
  const is_open = _.sumBy([...links], (link) => (link.isOpen() ? 1 : 0));
  const is_remote_open = _.sumBy([...links], (link) =>
    link.isRemoteOpen() ? 1 : 0
  );
  const is_closed = _.sumBy([...links], (link) => (link.isClosed() ? 1 : 0));
  const is_session_closed = _.sumBy([...links], (link) =>
    link.isSessionClosed() ? 1 : 0
  );
  /**
   * At reconnect period isOpen/isRemoteOpen == 0
   */
  log(
    ' [i] Consumed: %s, queues: %s, isOpen: %s, isRemoteOpen: %s, isClosed: %s, isSessionClosed: %s',
    processed,
    links.size,
    is_open,
    is_remote_open,
    is_closed,
    is_session_closed
  );
  if (is_open !== is_remote_open) {
    `Open local links doesn't match open remote links: ${is_open} != ${is_remote_open}`;
    await clean_before_exit(connection);
    process.exit(11);
  }
  if (is_session_closed !== 0 || is_closed !== 0) {
    `Closed links/sessions are present.`;
    await clean_before_exit(connection);
    process.exit(12);
  }
};

/**
 * Called when connection is established.
 * This will create amqp receiver-links.
 * This functions should not be called on reconnect.
 * Links survive reconnect.
 * Each link will map to VirtualTopic queue.
 * A Link can have the role of Receiver or Sender.
 * 1 link == 1 receiver.
 * In rhea-promise: 1 link is mapped to 1 session.
 * 1 link maps to ActiveMQ VirtualTopic queue.
 */
async function create_links(connection: Connection) {
  const topics = _.uniq(topics_cfg);
  for (const topic of topics) {
    /**
     * In UMB:
     * "consumer queues" match a pre-defined pattern (e.g. "Consumer.my-client.1234.VirtualTopic.foo")
     * Existence of the consumer queue acts as a subscription to the virtual-topic.
     * The consumer queue pattern on UMB is: "Consumer.$CLIENT_NAME.$SUBSCRIPTION_ID.VirtualTopic.>"
     */
    const is_exclusive = true;
    const receiver_address = `Consumer.${client_name}.${subscription_id}.${topic}`;
    let activemq_address = receiver_address;
    /**
     * https://activemq.apache.org/destination-options
     * Broker won’t let anyone else consume from this queue.
     * However, this is not clear if this works. Need more testing.
     */
    activemq_address =
      activemq_address + `?consumer.prefetchSize=${broker_cfg.prefetch}`;
    activemq_address =
      is_exclusive && activemq_address + '&consumer.exclusive=true';
    log(' [i] subscribe to queue: %s', receiver_address);
    const receiverOptions: ReceiverOptions = {
      credit_window: broker_cfg.prefetch,
      source: {
        address: activemq_address,
      },
      properties: {
        exclusive: true,
        'consumer.exclusive': true,
        consumer: {
          exclusive: true,
        },
      },
      autoaccept: false,
      onError: async (context) => {
        const receiverError = context.receiver && context.receiver.error;
        if (receiverError) {
          log(
            " [E] An error occurred for receiver '%s': %O.",
            receiver_address,
            receiverError
          );
        }
        console.warn(
          `Not recoverable link fatal error for: ${receiver_address}`
        );
        await clean_before_exit(connection);
        process.exit(21);
      },
      onSettled: (context) => {
        log(' [i] %s: settled', receiver_address);
      },
      onSessionError: async (context) => {
        console.warn(
          `Not recoverable session fatal error for: ${receiver_address}`
        );
        await clean_before_exit(connection);
        process.exit(22);
      },
      onClose: (context) => {
        log(' [i] %s link closed', receiver_address);
      },
      onSessionClose: (context) => {
        log(' [i] %s session closed', receiver_address);
      },
      onMessage: (context: EventContext) => {
        processed++;
        process_msg(context);
      },
    };
    try {
      const receiver: Receiver = await connection.createReceiver(
        receiverOptions
      );
      links.add(receiver);
    } catch (error) {
      log(' [E] Cannot create receiver for %s: %s', receiver_address);
    }
  }
}

async function broker_connect(): Promise<Connection> {
  const {
    connection: connectionOptions,
    failover: { set: failover },
  } = broker_cfg;
  assert.ok(
    _.some([
      _.negate(_.isEmpty)(connectionOptions.host),
      _.negate(_.isEmpty)(failover),
    ]),
    'Configuration error. Options is required one of: UMB-broker hostname or failover set.'
  );
  assert.ok(
    _.negate(_.isEmpty)(connectionOptions.key),
    'Configuration error. UMB-broker private key is missing'
  );
  assert.ok(
    _.negate(_.isEmpty)(connectionOptions.cert),
    'Configuration error. UMB-broker certificate is missing'
  );
  /**
   * Implementing failover
   * Ref: https://github.com/amqp/rhea/blob/master/examples/reconnect/client.js#L37
   */
  connectionOptions.incoming_locales = ['utf8'];
  const connection_details = (): ConnectionDetails => {
    var host, port;
    if (_.negate(_.isEmpty)(failover)) {
      const host_port = failover[attempt % failover.length];
      [host, port] = _.split(host_port, ':');
    } else {
      [host, port] = [connectionOptions.host, connectionOptions.port];
    }
    attempt++;
    log(` [i] Attempt ${attempt}. Connecting to: ${host}:${port}`);
    const details: ConnectionDetails = {
      port: _.toInteger(port),
      host: _.toString(host),
      options: {
        ...connectionOptions,
        host,
        port,
        connection_details: undefined,
      },
      transport: connectionOptions.transport,
    };
    return details;
  };
  connectionOptions.connection_details = connection_details;
  /**
   * activate heartbeat. milliseconds
   */
  connectionOptions.idle_time_out = 1000 * 60 * 1;
  var conn: Connection = new Connection(connectionOptions);
  conn.on(ConnectionEvents.connectionOpen, (context: EventContext) => {
    /**
     * This event is emmited on successful open()
     */
    log(' [i] Connection: is open.');
    if (links.size === 0) {
      /**
       * Session + links survive re-connect.
       */
      create_links(conn);
    }
  });
  conn.on(ConnectionEvents.disconnected, (context: EventContext) => {
    /**
     * Up to this moment connection could exist or be absent.
     * This event is emmited on un-successful connect/re-connect too.
     * Auto-recconnect takes care about this.
     */
    log(' [W] Connection: is disconnected.');
  });
  conn.on(ConnectionEvents.connectionClose, async (context: EventContext) => {
    /**
     * Connection was present.
     * This event happens by request from other side or when apps closes connection.
     * After this event will not follow disconnected() event.
     * Auto-reconnect doesn't take care about this.
     */
    if (!conn.wasCloseInitiated()) {
      /**
       * `true` if close was locally initiated, `false` otherwise
       */
      log(' [W] Connection was closed by peer.');
      await clean_before_exit(conn);
      process.exit(31);
    }
    log(' [i] Connection was closed.');
  });
  conn.on(ConnectionEvents.connectionError, (context: EventContext) => {
    /**
     * After this will follow connectionClose event
     */
    log(
      ' [W] Connection: remote peer indicates an error occurred: %O',
      context.message
    );
  });
  conn.on(ConnectionEvents.error, (context: EventContext) => {
    log(
      ' [W] Connection: error is received on the underlying socket: %O',
      context.message
    );
  });
  conn.on(ConnectionEvents.protocolError, (context: EventContext) => {
    log(
      ' [W] Connection: protocol error is received on the underlying socket: %O',
      context.message
    );
  });
  conn.on(ConnectionEvents.settled, (context: EventContext) => {
    log(
      ' [W] Connection: received a disposition (settled): %O',
      context.message
    );
  });
  try {
    await conn.open();
  } catch (error) {
    if (error?.code === 'ECONNREFUSED') {
      log(' [i] Ignore connection open() error. Retry mechanism follows up.');
    } else {
      throw error;
    }
  }
  return conn;
}

async function close_all_links() {
  for (const l of links) {
    let queue_name = l.source.address;
    const n = queue_name.indexOf('?');
    queue_name = queue_name.substring(0, n != -1 ? n : queue_name.length);
    if (l.isOpen()) {
      log(' [i] closing link for %s', queue_name);
      /**
       * Closes the underlying amqp link and optionally the session as well in rhea if open.
       * Also removes all the event handlers added in the rhea-promise library on the link
       * and optionally it's session.
       */
      try {
        await l.close({ closeSession: true });
        /**
         * Removes the underlying amqp link and it's session from the internal map in rhea. Also removes
         * all the event handlers added in the rhea-promise library on the link and it's session.
         */
        l.remove();
        links.delete(l);
      } catch (error) {
        log(' [E] connot close link: %queue_name: %s', queue_name, error);
        throw error;
      }
    }
  }
}

async function clean_before_exit(connection: Connection) {
  try {
    await close_all_links();
    if (connection.isOpen()) {
      await connection.close();
    }
  } catch (error) {
    /** Ignore errors at this step */
  }
}

async function handle_signal(
  connection: Connection,
  signal: NodeJS.Signals
): Promise<void> {
  log(`Received: ${signal}. Closing connection to AMQP server.`);
  await clean_before_exit(connection);
  log('Clean exit');
  process.exit(0);
}

/**
 * https://azuresdkdocs.blob.core.windows.net/$web/javascript/azure-core-amqp/1.0.1/classes/defaultdatatransformer.html
 *
 * gsim@ comment:
 * if the body has a typecode of 0x75, then the body.content will always be a buffer
 * the content_type (which would need to be set by the sender) could have further information about the contents of that buffer
 * e.g. application/json, would imply it was a json encoded string
 */
function convert_body_to_string(body: any) {
  let result;
  if (_.isString(body)) result = body;
  else if (body?.content) result = body.content.toString('utf8');
  else if (_.isBuffer(body)) result = body.toString('utf8');
  return result;
}

const process_msg = (context: EventContext): void => {
  if (_.isEmpty(context)) {
    log(' [x] event with empty context');
    return;
  }
  const { message, delivery } = context;
  if (message === undefined) {
    log(' [x] event with empty message');
    return;
  }
  const { to: topic, message_id, body } = message;
  if (topic === undefined || message_id === undefined) {
    log(' [x] event with incomplete message');
    return;
  }
  const address = topic.replace(/^topic:\/\//, '');
  const content_str = convert_body_to_string(body);
  try {
    var content_obj = JSON.parse(content_str);
  } catch (error) {
    log(
      ' [W] Cannot decode body, skipping message: %s, %s, %O',
      message_id,
      error,
      content_str
    );
    delivery?.accept();
    return;
  }
  log(' [x] %s, %s', address, message_id);
  const unix_time = Math.floor(new Date().getTime() / 1000);
  /** Generate disctinct file-queue id. It is not related to messageID from broker. */
  const fqueue_id = `${unix_time}-${message_id}`;
  const payload_obj = {
    body: content_obj,
    address,
    fqueue_id,
    message_id,
    header_timestamp: message?.application_properties?.timestamp,
    provider_name: listener_name,
    provider_timestamp: unix_time,
  };
  fq.push(fqueue, payload_obj).catch((err) => {
    console.warn('Could not store message at file-queue: %s.', err);
    throw err;
  });
  /**
   * Acknowledge to the broker that the message is processed on our side, and can be discarded.
   */
  delivery?.accept();
};

async function start(): Promise<void> {
  assert.ok(
    _.negate(_.isEmpty)(client_name),
    'client_name in configuration cannot be empty. It must match CN from certificate subject.'
  );
  file_queue_path = mkDirParents(file_queue_path_cfg);
  log('File-queue path: %s', file_queue_path);
  fqueue = await fq.make(file_queue_path);
  const connection: Connection = await broker_connect();
  const clean_on: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGABRT'];
  for (const signal of clean_on) {
    process.once(signal, _.curry(handle_signal)(connection));
  }
  const status_task = cron.schedule(
    /** running a task every minute */
    '* * * * *',
    _.partial(status, links, connection)
  );
  log(' [*] To exit press CTRL+C');
}

start().catch((error) => {
  console.warn(error);
  process.exit(1);
});
