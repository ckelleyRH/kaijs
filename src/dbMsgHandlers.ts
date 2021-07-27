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
import debug from 'debug';
import assert from 'assert';
import crypto from 'crypto';

import { Artifacts } from './db';
import { koji_query, KojiHubName } from './koji';
import {
  ArtifactModel,
  ArtifactState,
  ArtifactTypes,
  atype_to_hub_map,
  KaiState,
} from './dbInterface';
import { assert_is_valid } from './validation';

const log = debug('kaijs:dbMsgHandlers');

export class NoAssociatedHandlerError extends Error {
  constructor(m: string, public broker_topic: string) {
    super(m);
    /**
     * Set the prototype explicitly.
     */
    Object.setPrototypeOf(this, NoAssociatedHandlerError.prototype);
  }
}

export class NoThreadIdError extends Error {
  constructor(m: string) {
    super(m);
    /**
     * Set the prototype explicitly.
     */
    Object.setPrototypeOf(this, NoAssociatedHandlerError.prototype);
  }
}

function customMerge(presentVaule: any, newValue: any) {
  if (_.isArray(presentVaule) && _.isArray(newValue) && _.isEmpty(newValue)) {
    return presentVaule;
  }
  if (_.isString(presentVaule) && _.isString(newValue) && _.isEmpty(newValue)) {
    return presentVaule;
  }
  /**
   * Return: undefined
   * If customizer returns undefined, merging is handled by the method instead:
   * Source properties that resolve to undefined are skipped if a destination value exists.
   * Array and plain object properties are merged recursively.
   * Other objects and value types are overridden by assignment.
   */
}

/**
 * "msg": {
 *  "build_id": 1728223,
 *  "name": "gcompris-qt",
 *  "instance": "primary",
 *  "tag": "f33-updates",
 *  "user": "bodhi",
 *  "version": "1.1",
 *  "owner": "musuruan",
 *  "release": "1.fc33"
 * }
 */
const handler_buildsys_tag = async (
  type: ArtifactTypes,
  artifacts: Artifacts,
  msg: any
): Promise<ArtifactModel> => {
  assert.ok(
    _.has(atype_to_hub_map, type),
    `handler_buildsys_tag() was called for unknown artifact type: ${type}`
  );
  const hub_name: KojiHubName = _.get(atype_to_hub_map, type);
  const { address: routingKey, message_id, body: tag_msg } = msg;
  const { build_id } = tag_msg;
  var buildInfo;
  try {
    buildInfo = await koji_query(hub_name, 'getBuild', build_id);
  } catch (err) {
    log(
      ' [E] handler_buildsys_tag cannot get buildInfo for build_id: %s',
      tag_msg.build_id
    );
    throw err;
  }
  assert_is_valid(buildInfo, 'koji_build_info');
  const task_id = buildInfo.task_id;
  var artifact;
  try {
    artifact = await artifacts.findOrCreate(type, _.toString(task_id));
  } catch (err) {
    log(' [E] handler_buildsys_tag failed for task_id: %s', task_id);
    throw err;
  }
  const rpm_build: ArtifactModel['rpm_build'] = {
    task_id,
    build_id,
    nvr: _.get(buildInfo, 'nvr'),
    issuer: tag_msg.owner,
    source: _.get(buildInfo, 'extra.source.original_url'),
    scratch: false,
    component: _.get(buildInfo, 'name'),
  };
  /**
   * Mutate artifact.rpm_build, assign any way, if artifact.rpm_build was undefined before
   */
  artifact.rpm_build = _.mergeWith(artifact.rpm_build, rpm_build, customMerge);
  log(' [i] handler_buildsys_tag updated doc: %s%o', '\n', artifact);
  return artifact;
};

const mk_thread_id = (broker_msg: any) => {
  const { address: routingKey, message_id, body: msg } = broker_msg;
  var thread_id = _.get(msg, 'pipeline.id');
  if (!_.isEmpty(thread_id) && _.isString(thread_id)) {
    return thread_id;
  }
  var run_url = _.get(msg, 'run.url');
  if (!_.isEmpty(run_url) && _.isString(run_url)) {
    /**
     * if msg_body.pipeline.id is absent generate a dummy thread_id based on
     * msg_body.run.url
     * if msg_body.run.url is abset too -> NACK this message
     * msg_body.run is required entry according to schema:
     * https://pagure.io/fedora-ci/messages/blob/master/f/schemas/run.yaml#_59
     *
     * Old code:
     *
     * dummy_thread_id = 'dummy-thread-{}'.format(hashlib.sha256('{}-{}-{}-{}-{}'.format(
     *           body.get('ci', {}).get('url', body.get('ci', {}).get('name', '')),
     *           body['run']['url'],
     *           body.get('stage', 'test'),
     *           body.get('category', 'functional'),
     *           body.get('type', 'tier1'))).hexdigest())
     *
     */
    const hash = crypto.createHash('sha256').update(run_url).digest('hex');
    thread_id = `dummy-thread-${hash}`;
    return thread_id;
  }
  new NoThreadIdError(`Cannot make thread-id for broker msg-id: ${message_id}`);
};

const mk_state = (broker_msg: any): ArtifactState => {
  const { address: routingKey, message_id, body: msg } = broker_msg;
  var thread_id = mk_thread_id(broker_msg);
  var msg_id = message_id;
  var version = _.get(msg, 'version');
  /**
   * state is used in updating `current-state` entry
   */
  var state = _.last(_.split(routingKey, '.')) as string;
  var stage = _.nth(_.split(routingKey, '.'), -2) as string;
  var timestamp = Date.parse(_.get(msg, 'generated_at'));
  var origin = {
    creator: 'kaijs-loader',
    reason: 'broker message',
  };
  const kai_state: KaiState = {
    thread_id,
    msg_id,
    version,
    stage,
    state,
    timestamp,
    origin,
  };
  const namespace = _.get(msg, 'test.namespace');
  const type = _.get(msg, 'test.type');
  const category = _.get(msg, 'test.category');
  if (_.size(namespace) && _.size(type) && _.size(category)) {
    const test_case_name = `${namespace}.${type}.${category}`;
    kai_state.test_case_name = test_case_name;
  }
  assert_is_valid(kai_state, 'kai_state');
  var new_state: ArtifactState = {
    broker_msg_body: msg,
    kai_state,
  };
  return new_state;
};

/**
 * Update:
 *  'current-state'
 *  'current-state-lengths'
 *  'resultsdb_testcase'
 * Sorts thread_id by time, uses the most recent entry
 * 'current-state-lengths' - entry is used by dashboard to show quick status of tests
 * otherwise to get this info dashboard need to pull all 'current-state', which can be heavy.
 * 'resultsdb_testcase' - allows dashboard search by testcase name.
 */
const actualize_current_states = (db_artifact: ArtifactModel) => {
  /**
   * thread_id is mandatory field. It present in each state-entry.
   * Split all states in groups by thread_id
   */
  const states_for_same_thread = _.values(
    _.groupBy(db_artifact.states, 'kai_state.thread_id')
  );
  log(' [d] steates for same thread: %O', states_for_same_thread);
  /**
   * get the most recent state for each thread
   */
  const recent_for_each_thread = _.map(
    states_for_same_thread,
    _.flow(
      _.identity,
      _.partialRight(_.orderBy, 'kai_state.timestamp', 'desc'),
      _.first
    )
  );
  log(' [d] recent states for each thread: %O', recent_for_each_thread);
  const current_state = _.groupBy(
    _.flatten(recent_for_each_thread),
    'kai_state.state'
  );
  /**
   * Add known empty states, if do not add - the old will persist
   */
  const known_states = [
    ...new Set(_.map(db_artifact.states, _.property('kai_state.state'))),
  ];
  _.remove(known_states, _.isEmpty);
  const current_state_empty = _.chain(known_states)
    .keyBy()
    .mapValues(_.constant([]))
    .value();
  _.assign(current_state, _.omit(current_state_empty, _.keys(current_state)));
  db_artifact.current_state = current_state as ArtifactModel['current_state'];
  log(' [d] current_state: %O', current_state);
  const current_state_lenghts = _.mapValues(
    current_state,
    _.flow(_.identity, _.size)
  );
  db_artifact.current_state_lenghts =
    current_state_lenghts as ArtifactModel['current_state_lenghts'];
  const resultsdb_testcase = [
    ...new Set(
      _.map(db_artifact.states, _.property('kai_state.test_case_name'))
    ),
  ];
  _.remove(resultsdb_testcase, _.isEmpty);
  db_artifact.resultsdb_testcase =
    resultsdb_testcase as ArtifactModel['resultsdb_testcase'];
};

/**
 * Create a db-entry with schema: schema_db_artifact
 * Extract only required fields.
 * Store unmodified message at 'db_artifact.states[]'.
 * msg - passed schema_rpm_build_test_complete schema
 *
 * Example:
 *
 * https://apps.fedoraproject.org/datagrepper/raw?topic=org.centos.prod.ci.koji-build.test.complete&delta=127800
 *
 * Topics:
 *
 * * org.centos.prod.ci.koji-build.test.complete
 *
 * Supported versions: https://pagure.io/fedora-ci/messages/releases
 *
 * * 0.2.1
 */
const handler_rpm_build_test_common = async (
  artifacts: Artifacts,
  broker_msg: any
): Promise<ArtifactModel> => {
  const { address: routingKey, message_id, body: msg } = broker_msg;
  const { test, artifact } = msg;
  const type = artifact.type;
  const task_id = artifact.id;
  var db_artifact;
  try {
    db_artifact = await artifacts.findOrCreate(type, _.toString(task_id));
  } catch (err) {
    log(' [E] handler_rpm_build_test_complete failed for task_id: %s', task_id);
    throw err;
  }
  const rpm_build: ArtifactModel['rpm_build'] = {
    task_id,
    nvr: _.get(artifact, 'nvr'),
    source: _.get(artifact, 'source'),
    issuer: _.get(artifact, 'issuer'),
    scratch: _.get(artifact, 'scratch'),
    component: _.get(artifact, 'component'),
  };
  /**
   * Store broker-message to new state
   */
  const artifact_new_state = mk_state(broker_msg);
  const thread_id = artifact_new_state.kai_state.thread_id;
  db_artifact.states = _.defaultTo(db_artifact.states, []);
  if (!_.includes(_.map(db_artifact.states, 'kai_state.msg_id'), message_id)) {
    log(
      ' [i] handler_rpm_build_test_complete adding new state with thread_id: %s, msg_id: %s',
      thread_id,
      message_id
    );
    db_artifact.states.push(artifact_new_state);
    /**
     * Update 'current-state' and 'current-state-lengths'
     */
    actualize_current_states(db_artifact);
  } else {
    log(
      ' [i] handler_rpm_build_test_complete already present state with msg_id: %s, msg_id: %s',
      thread_id,
      message_id
    );
  }
  db_artifact.rpm_build = _.mergeWith(
    db_artifact.rpm_build,
    rpm_build,
    customMerge
  );
  log(
    ' [i] handler_rpm_build_test_complete updated doc: %s%o',
    '\n',
    db_artifact
  );
  return db_artifact;
};

const handler_redhat_module_test_complete = async (
  artifacts: Artifacts,
  broker_msg: any
): Promise<ArtifactModel | undefined> => {
  /**
   * modularity content do not have schema contend defined in
   * https://pagure.io/fedora-ci/messages/
   * https://issues.redhat.com/browse/OSCI-2280
   *
   * .nsvc: string
   * .stream: string;
   * .version: string;
   * .context: string;
   *
   */
  return undefined;
};

var handlers = new Map();
export function get_handler(broker_topic: string) {
  return _.last(
    _.find([...handlers], ([re]) => re.test(broker_topic)) as
      | Array<any>
      | undefined
  );
}

/**
 * Declare set() from most specialized to most global regexes
 */
/**
 * https://apps.fedoraproject.org/datagrepper/raw?topic=org.centos.prod.buildsys.tag&delta=12780
 * https://apps.fedoraproject.org/datagrepper/raw?topic=org.fedoraproject.prod.buildsys.tag&delta=127800
 */
handlers.set(
  /^org.centos.prod.buildsys.tag$/,
  _.partial(handler_buildsys_tag, 'koji-build-cs')
);
handlers.set(
  /^org.fedoraproject.prod.buildsys.tag$/,
  _.partial(handler_buildsys_tag, 'koji-build')
);
/**
 * https://apps.fedoraproject.org/datagrepper/raw?topic=org.centos.prod.ci.koji-build.test.complete&delta=127800
 * https://pagure.io/fedora-ci/messages/blob/master/f/schemas/brew-build.test.complete.yaml
 */
handlers.set(
  /^org.centos.prod.ci.koji-build.test.(complete|queued|running|error)$/,
  handler_rpm_build_test_common
);
