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

import _ from 'lodash';
import Joi from 'joi';
import debug from 'debug';
import {
  Db,
  Collection,
  MongoError,
  MongoClient,
  MongoClientOptions,
} from 'mongodb';
import assert from 'assert';

import { getcfg } from './cfg';
import {
  drop_empty_paths,
  path_mongodb_to_lodash,
  paths_mongodb_pack_array,
} from './paths';
import { metrics_up_broker } from './metrics';
import {
  ArtifactModel,
  ValidationErrorsModel,
  UnknownBrokerTopicModel,
} from './dbInterface';
import { get_handler, NoAssociatedHandlerError } from './dbMsgHandlers';
import { assert_is_valid, SchemaName } from './validation';
import { FileQueueMessage } from './fqueue';

const log = debug('kaijs:db');
const cfg = getcfg();
const db_cfg = cfg.loader.db;

function on_close(err: MongoError): void {
  console.warn(`db socket closed: ${err}`);
  process.exit(1);
}

function on_error(err: MongoError): void {
  console.warn(`db error occurred: ${err}`);
  process.exit(1);
}

function on_timeout(err: MongoError): void {
  console.warn(`socket timeout occurred: ${err}`);
  process.exit(1);
}

function on_parseError(err: MongoError): void {
  console.warn(
    `db driver detects illegal or corrupt BSON being received from the server: ${err}`
  );
  process.exit(1);
}

function on_reconnect(obj: any): void {
  console.warn(`driver has reconnected and re-authenticated`);
}

class DBCollection {
  private cfg_entry: keyof typeof cfg.loader.db.collections;
  public collection_name: string;
  public url: string;
  /** Use the same DB instance. Any consequential db-open will return the same instance. */
  public db?: Db;
  public collection?: Collection<any>;
  /** Mongo client -> client-server connection -> db instance 1, db instance 2, ... */
  public mongo_client: MongoClient;
  public db_name?: string;
  public options?: MongoClientOptions;
  public static def_options = {
    useUnifiedTopology: true,
  };

  constructor(
    cfg_entry: keyof typeof cfg.loader.db.collections,
    url?: string,
    collection_name?: string,
    db_name?: string,
    options?: MongoClientOptions
  ) {
    this.cfg_entry = cfg_entry;
    this.url = url || cfg.loader.db.db_url;
    this.collection_name =
      collection_name || cfg.loader.db.collections[this.cfg_entry].name;
    this.db_name = db_name || cfg.loader.db.db_name;
    /** http://mongodb.github.io/node-mongodb-native/3.6/api/MongoClient.html */
    const opts = options || _.cloneDeep(DBCollection.def_options);
    _.merge(opts, options);
    this.mongo_client = new MongoClient(this.url, opts);
  }

  log(s: string, ...args: any[]): void {
    const msg = ` [i] ${this.collection_name} ${s}`;
    log(msg, ...args);
  }

  fail(s: string, ...args: any[]): void {
    const msg = ` [E] ${this.collection_name} ${s}`;
    log(msg, ...args);
  }

  async init(): Promise<void> {
    try {
      await this.mongo_client.connect();
      /** If db name is not provided, use database name from connection string. */
      this.db = this.mongo_client.db(this.db_name);
      /** verify connection */
      this.db.command({ ping: 1 });
      const collections = await this.db.listCollections().toArray();
      const collectionNames = collections.map((c) => c.name);
      if (!collectionNames.includes(this.collection_name)) {
        await this.db.createCollection(this.collection_name);
      }
      this.collection = this.db.collection<ValidationErrorsModel>(
        this.collection_name
      );
      this.log('Connected successfully to collection.');
      /** Db is no longer the place to listen to events, you should listen to your MongoClient. */
      this.db.on('close', on_close);
      this.db.on('error', on_error);
      this.db.on('error', on_timeout);
      this.db.on('reconnect', on_reconnect);
      this.db.on('parseError', on_parseError);
    } catch (err) {
      this.mongo_client.close();
      throw err;
    }
  }

  async cfg_indexes(): Promise<void> {
    this.log('Configure indexes.');
    const indexes_config = cfg.loader.db.collections[this.cfg_entry].indexes;
    const indexes_active = await this.collection?.indexes();
    this.log('Active indexes: %o', indexes_active);
    this.log('Indexes in configuration: %o', indexes_config);
    const preserve = ['_id_'];
    /** Drop indexes that are absent in configuration */
    const keep = preserve.concat(
      _.map(
        indexes_config,
        _.flow(_.identity, _.partialRight(_.get, 'options.name'))
      )
    );
    if (_.size(indexes_active)) {
      for (const index of indexes_active) {
        if (keep.includes(index.name)) {
          this.log('Keep index: %s', index.name);
          continue;
        }
        this.log('Drop index: %s', index.name);
        await this.collection?.dropIndex(index.name);
      }
    }
    if (!_.size(indexes_config)) {
      this.log('No configuration for indexes.');
      return;
    }
    for (const index of indexes_config) {
      const name = _.get(index, 'options.name');
      const is_present =
        _.findIndex(
          indexes_active,
          _.flow(
            _.identity,
            _.partialRight(_.get, 'name'),
            _.partialRight(_.isEqual, name)
          )
        ) >= 0;
      if (is_present) {
        this.log('Index is already present: %s', name);
        continue;
      }
      this.log('Add index: %s', name);
      await this.collection?.createIndex(index.keys, index.options);
    }
  }

  async close(): Promise<void> {
    try {
      await this.mongo_client.close();
    } catch (err) {
      this.fail('Cannot close connection to DB.');
      throw err;
    }
  }
}

/**
 * Operates on mongodb collection
 */
export class ValidationErrors extends DBCollection {
  constructor(
    url?: string,
    collection_name?: string,
    db_name?: string,
    options?: MongoClientOptions
  ) {
    super('invalid', collection_name, url, db_name, options);
  }

  async add_to_db(
    fq_msg: FileQueueMessage,
    err: Joi.ValidationError
  ): Promise<void> {
    const expire_at = new Date();
    var keep_days = 15;
    expire_at.setDate(expire_at.getDate() + keep_days);
    const document: ValidationErrorsModel = {
      timestamp: Date.now(),
      time: new Date().toString(),
      broker_msg: fq_msg.body,
      errmsg: err.details,
      expire_at,
      broker_topic: fq_msg.broker_topic,
    };
    try {
      await this.collection?.insertOne(document);
      this.log('Stored invalid object');
    } catch (err) {
      this.fail('Cannot store invalid object.');
      throw err;
    }
  }
}

/**
 * Operates on mongodb collection
 */
export class UnknownBrokerTopics extends DBCollection {
  constructor(
    url?: string,
    collection_name?: string,
    db_name?: string,
    options?: MongoClientOptions
  ) {
    super('no_handler', collection_name, url, db_name, options);
  }
  async add_to_db(
    fq_msg: FileQueueMessage,
    err: NoAssociatedHandlerError
  ): Promise<void> {
    const expire_at = new Date();
    var keep_days = 15;
    expire_at.setDate(expire_at.getDate() + keep_days);
    const document: UnknownBrokerTopicModel = {
      timestamp: Date.now(),
      time: new Date().toString(),
      broker_msg: fq_msg.body,
      broker_topic: err.broker_topic,
      expire_at,
    };
    try {
      await this.collection?.insertOne(document);
      this.log('Stored invalid object');
    } catch (err) {
      this.fail('Cannot store invalid object.');
      throw err;
    }
  }
}

/**
 * Operates on mongodb collection
 */
export class Artifacts extends DBCollection {
  constructor(
    url?: string,
    collection_name?: string,
    db_name?: string,
    options?: MongoClientOptions
  ) {
    super('artifacts', collection_name, url, db_name, options);
  }

  async findOrCreate(type: string, aid: string): Promise<ArtifactModel> {
    if (_.isUndefined(this.collection)) {
      throw new Error('Connection is not initialized');
    }
    /** http://mongodb.github.io/node-mongodb-native/3.6/api/Collection.html#findOneAndUpdate */
    var result;
    this.log('Getting mongodb document for type: %s and aid: %s', type, aid);
    try {
      result = await this.collection.findOneAndUpdate(
        /** query / filter */
        { type, aid },
        /** update */
        {
          $setOnInsert: { type, aid, _version: 1 },
        },
        /** options */
        {
          /** false == returns the updated document rather than the original */
          returnOriginal: false,
          /** insert the document if it does not exist */
          upsert: true,
        }
      );
    } catch (err) {
      /**
       * Can throw an exception when user does not have RO permissions
       */
      this.fail('findOrCreate() failed for type: %s, aid: %s', type, aid);
      throw err;
    }
    const { value: document, lastErrorObject, ok } = result;
    this.log(
      'Document for type: %s and aid: %s is:%s%O',
      type,
      aid,
      '\n',
      document
    );
    /**
     * On success:
     *
     * lastErrorObject: { n: 1, updatedExisting: false, upserted: 608152d136ffcb6b327711a1 }
     * ok: 1
     */
    assert_is_valid(document, 'db_artifact');
    return document as ArtifactModel;
  }

  /**
   * * Always rewrite old arrays or new arrays values
   * * Does not update scalar values with new values
   * * Does not remove old scalar values
   */
  mk_update_set(present: ArtifactModel, newdata: ArtifactModel) {
    const paths_new = paths_mongodb_pack_array(newdata);
    const paths_present = paths_mongodb_pack_array(present);
    /**
     * Drop path that resolve to isNull or isUndefined
     */
    drop_empty_paths(paths_new, newdata);
    drop_empty_paths(paths_present, present);
    /**
     * Get paths:
     *
     *  * present in newdata, but absent in present
     * 	or
     *  * always takes path from newdata that resolves to array
     */
    const paths_update = _.differenceWith(
      paths_new,
      paths_present,
      /**
       * when to drop path
       */
      (new_path, old_path) => {
        const new_path_lodash = path_mongodb_to_lodash(new_path);
        const old_path_lodash = path_mongodb_to_lodash(old_path);
        const new_value = _.get(newdata, new_path_lodash);
        const old_value = _.get(present, old_path_lodash);
        const drop = _.isEqual(new_value, old_value);
        return drop;
      }
    );
    const pairs = _.map(
      paths_update,
      _.unary(_.over(_.identity, _.partial(_.get, newdata)))
    );
    return _.fromPairs(pairs);
  }

  /**
   * @param artifact - holds data, necessary add to DB.
   * @returns updated document
   */
  async add(message: FileQueueMessage): Promise<ArtifactModel> {
    const { broker_topic, broker_msg_id: message_id } = message;
    if (_.isUndefined(this.collection)) {
      throw new Error('Connection is not initialized');
    }
    const handler = get_handler(broker_topic);
    this.log("'%s', %s", broker_topic, message_id);
    if (_.isUndefined(handler)) {
      const metric_name = 'handler-' + broker_topic;
      metrics_up_broker(metric_name, 'nack');
      log(' [E] No handler for topic: %s', broker_topic);
      const errmsg = `broker msg-id: ${message_id}: does not have associated handler for topic '${broker_topic}'.`;
      throw new NoAssociatedHandlerError(errmsg, broker_topic);
    }
    /** Retry update artifact entry in db */
    let retries_left = 30;
    var artifact: any;
    let modifiedDocument = null;
    const options = { returnOriginal: false };
    while (_.isNull(modifiedDocument) && retries_left > 1) {
      retries_left -= 1;
      if (retries_left === 0) {
        break;
      }
      /**
       * handler().message.id:
       *
       *   1) Finds or creates a new mongodb-document for pair: type + aid
       *   2) Returns updated object with updated values
       *
       */
      artifact = await handler(this, message);
      /**
       * Check if new document is valid before it update
       */
      assert_is_valid(artifact, 'db_artifact');
      const { type, aid } = artifact;
      var db_entry;
      try {
        db_entry = await this.findOrCreate(type, aid);
      } catch (err) {
        /**
         * try again
         */
        continue;
      }
      const update_set = this.mk_update_set(db_entry, artifact);
      if (_.isEmpty(update_set)) {
        this.log(
          'Update set is empty for type: %s aid: %s. Do not update document.',
          type,
          aid
        );
        return artifact;
      }
      const filter = _.pick(db_entry, '_id', '_version');
      const updateDoc = {
        $inc: { _version: 1 },
        $set: update_set,
      };
      /**
       * Return null if no document was not updated
       * Concurrency protected
       * https://docs.particular.net/persistence/mongodb/document-version
       */
      try {
        /**
         * lastErrorObject - status of last operation
         * https://docs.mongodb.com/manual/reference/command/findAndModify/#output
         */
        const {
          ok,
          value,
          /** Contains information about updated documents.  */
          lastErrorObject,
        } = await this.collection.findOneAndUpdate(filter, updateDoc, options);
        /** Contains the command's execution status. 1 on success, or 0 if an error occurred. */
        assert.ok(ok === 1, 'Cannot update artifact document with new values.');
        /** Contains true if an update operation modified an existing document. */
        assert.ok(
          lastErrorObject.updatedExisting === true,
          'Error to upate existing artifact document with new values'
        );
        modifiedDocument = value;
      } catch (err) {
        /**
         * Can throw an exception when user does not have RO permissions
         */
        this.fail(
          'Cannot update db. Retries left: %s:%s%s',
          retries_left,
          '\n',
          err.message
        );
      }
      if (modifiedDocument) {
        return modifiedDocument as ArtifactModel;
      }
    }
    throw new Error(
      `Cannot set missing fields for type: ${artifact.type} and aid: ${artifact.aid}. All attempts failed.`
    );
  }

  async add_to_db(message: FileQueueMessage): Promise<void> {
    const { broker_topic, broker_msg_id } = message;
    /**
     * Verify for correctness of input message with associated schema.
     */
    assert_is_valid(message.body, broker_topic as SchemaName);
    /**
     * Invoke associated handler for the message
     */
    try {
      /**
       * add(): writes updated object to DB
       */
      await this.add(message);
    } catch (err) {
      this.fail(
        'Cannot update DB for message-id: %s and broker-topic: %s',
        broker_msg_id,
        broker_topic
      );
      throw err;
    }
  }
}

export async function get_collection(
  name: keyof typeof cfg.loader.db.collections,
  url?: string,
  collection_name?: string,
  db_name?: string,
  options?: MongoClientOptions
): Promise<Artifacts | ValidationErrors | UnknownBrokerTopics> {
  var Class;
  if (name === 'artifacts') {
    Class = Artifacts;
  } else if (name === 'invalid') {
    Class = ValidationErrors;
  } else if (name === 'no_handler') {
    Class = UnknownBrokerTopics;
  } else {
    throw new Error('Unknown collection name.');
  }
  const collection = new Class(url, collection_name, db_name, options);
  await collection.init();
  await collection.cfg_indexes();
  return collection;
}
