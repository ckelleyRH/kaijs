/*
 * This file is part of kaijs

 * Copyright (c) 2021, 2022 Andrei Stepanov <astepano@redhat.com>
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
import {
  TPayload,
  KaiState,
  ArtifactState,
  ArtifactModel,
} from './db_interface';
import { Artifacts } from './db';
import { FileQueueMessage } from './fqueue';
import { assert_is_valid } from './validation';
import { handlers as handlersRPMBuild } from './msg_handlers_rpm_build';
import { handlers as handlersKojiBrew } from './msg_handlers_koji_brew';

const log = debug('kaijs:msg_handlers');

export type TGetPayload = (body: any) => TPayload;
export type THandler = (
  artifacts: Artifacts,
  fq_msg: FileQueueMessage
) => Promise<ArtifactModel>;
export type THandlersSet = Map<RegExp, THandler>;
export type TPayloadHandlersSet = Map<RegExp, TGetPayload>;

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
    Object.setPrototypeOf(this, NoThreadIdError.prototype);
  }
}

export function customMerge(presentVaule: any, newValue: any) {
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

const mkThreadId = (fq_msg: FileQueueMessage) => {
  const { broker_msg_id, body } = fq_msg;
  var thread_id = _.get(body, 'pipeline.id');
  if (!_.isEmpty(thread_id) && _.isString(thread_id)) {
    return thread_id;
  }
  var run_url = _.get(body, 'run.url');
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
  new NoThreadIdError(
    `Cannot make thread-id for broker msg-id: ${broker_msg_id}`
  );
};

export const makeState = (fq_msg: FileQueueMessage): ArtifactState => {
  const { broker_topic, broker_msg_id, body } = fq_msg;
  var thread_id = mkThreadId(fq_msg);
  var msg_id = broker_msg_id;
  var version = _.get(body, 'version');
  var state = _.last(_.split(broker_topic, '.')) as string;
  var stage = _.nth(_.split(broker_topic, '.'), -2) as string;
  var timestamp = Date.parse(_.get(body, 'generated_at'));
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
  const namespace = _.get(body, 'test.namespace');
  const type = _.get(body, 'test.type');
  const category = _.get(body, 'test.category');
  if (_.size(namespace) && _.size(type) && _.size(category)) {
    const test_case_name = `${namespace}.${type}.${category}`;
    kai_state.test_case_name = test_case_name;
  }
  assert_is_valid(kai_state, 'kai_state');
  var new_state: ArtifactState = {
    broker_msg_body: body,
    kai_state,
  };
  return new_state;
};

export const getPayloadHandlerByMsgVersion = (
  msgBody: any,
  handlerSet: TPayloadHandlersSet
): TGetPayload => {
  const version = _.get(msgBody, 'version');
  const regexAndHandler = _.find<[RegExp, TGetPayload]>(
    _.toArray(handlerSet as any),
    ([regex, _h]) => regex.test(version)
  );
  assert.ok(
    _.isArray(regexAndHandler),
    `Cannot find handler for version: ${version}`
  );
  const [_r, handler] = regexAndHandler;
  return handler;
};

const allKnownHandlers: THandlersSet = new Map<RegExp, THandler>();

/**
 * Populate all allKnownHandlers for each category
 */
handlersRPMBuild.forEach((value, key) => allKnownHandlers.set(key, value));
handlersKojiBrew.forEach((value, key) => allKnownHandlers.set(key, value));

log(
  ' [i] known handlers: %O',
  _.map([...allKnownHandlers], ([re]) => _.toString(re))
);

export function getHandler(broker_topic: string) {
  return _.last(
    _.find([...allKnownHandlers], ([re]) => re.test(broker_topic)) as
      | Array<any>
      | undefined
  );
}
