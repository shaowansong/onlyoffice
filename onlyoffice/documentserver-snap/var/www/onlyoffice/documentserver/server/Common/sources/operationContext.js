/*
 * Copyright (C) undefined 2012-2023. All rights reserved
 *
 * undefined 
 *
 * Version: 7.5.1 (build:0)
 */

'use strict';

const utils = require('./utils');
const logger = require('./logger');
const constants = require('./constants');
const tenantManager = require('./tenantManager');

function Context(){
  this.logger = logger.getLogger('nodeJS');
  this.initDefault();
}
Context.prototype.init = function(tenant, docId, userId) {
  this.setTenant(tenant);
  this.setDocId(docId);
  this.setUserId(userId);

  this.config = null;
  this.secret = null;
  this.license = null;
};
Context.prototype.initDefault = function() {
  this.init(tenantManager.getDefautTenant(), constants.DEFAULT_DOC_ID, constants.DEFAULT_USER_ID);
};
Context.prototype.initFromConnection = function(conn) {
  let tenant = tenantManager.getTenantByConnection(this, conn);
  let docId = conn.docid;
  if (!docId) {
    let handshake = conn.handshake;
    const docIdParsed = constants.DOC_ID_SOCKET_PATTERN.exec(handshake.url);
    if (docIdParsed && 1 < docIdParsed.length) {
      docId = docIdParsed[1];
    }
  }
  let userId = conn.user?.id;
  this.init(tenant, docId || this.docId, userId || this.userId);
};
Context.prototype.initFromRequest = function(req) {
  let tenant = tenantManager.getTenantByRequest(this, req);
  this.init(tenant, this.docId, this.userId);
};
Context.prototype.initFromTaskQueueData = function(task) {
  let ctx = task.getCtx();
  this.init(ctx.tenant, ctx.docId, ctx.userId);
};
Context.prototype.initFromPubSub = function(data) {
  let ctx = data.ctx;
  this.init(ctx.tenant, ctx.docId, ctx.userId);
};
Context.prototype.initTenantCache = async function() {
  this.config = await tenantManager.getTenantConfig(this);
};

Context.prototype.setTenant = function(tenant) {
  this.tenant = tenant;
  this.logger.addContext('TENANT', tenant);
};
Context.prototype.setDocId = function(docId) {
  this.docId = docId;
  this.logger.addContext('DOCID', docId);
};
Context.prototype.setUserId = function(userId) {
  this.userId = userId;
  this.logger.addContext('USERID', userId);
};
Context.prototype.toJSON = function() {
  return {
    tenant: this.tenant,
    docId: this.docId,
    userId: this.userId
  }
};
Context.prototype.getCfg = function(property, defaultValue) {
  if (this.config){
    return getImpl(this.config, property) ?? defaultValue;
  }
  return defaultValue;
};
function getImpl(object, property) {
  var t = this,
    elems = Array.isArray(property) ? property : property.split('.'),
    name = elems[0],
    value = object[name];
  if (elems.length <= 1) {
    return value;
  }
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  return getImpl(value, elems.slice(1));
};

exports.Context = Context;
exports.global = new Context();
