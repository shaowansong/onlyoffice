/*
 * Copyright (C) undefined 2012-2023. All rights reserved
 *
 * undefined 
 *
 * Version: 7.5.1 (build:0)
 */


'use strict';

const { Server } = require("socket.io");
const _ = require('underscore');
const url = require('url');
const os = require('os');
const cluster = require('cluster');
const crypto = require('crypto');
const pathModule = require('path');
const co = require('co');
const jwt = require('jsonwebtoken');
const ms = require('ms');
const deepEqual  = require('deep-equal');
const bytes = require('bytes');
const storage = require('./../../Common/sources/storage-base');
const constants = require('./../../Common/sources/constants');
const utils = require('./../../Common/sources/utils');
const commonDefines = require('./../../Common/sources/commondefines');
const statsDClient = require('./../../Common/sources/statsdclient');
const config = require('config');
const sqlBase = require('./baseConnector');
const canvasService = require('./canvasservice');
const converterService = require('./converterservice');
const taskResult = require('./taskresult');
const gc = require('./gc');
const shutdown = require('./shutdown');
const pubsubService = require('./pubsubRabbitMQ');
const wopiClient = require('./wopiClient');
const queueService = require('./../../Common/sources/taskqueueRabbitMQ');
const operationContext = require('./../../Common/sources/operationContext');
const tenantManager = require('./../../Common/sources/tenantManager');

const editorDataStorage = require('./' + config.get('services.CoAuthoring.server.editorDataStorage'));

const cfgEditSingleton =  config.get('services.CoAuthoring.server.edit_singleton');
const cfgEditor =  config.get('services.CoAuthoring.editor');
const cfgCallbackRequestTimeout = config.get('services.CoAuthoring.server.callbackRequestTimeout');
const cfgAscSaveTimeOutDelay = config.get('services.CoAuthoring.server.savetimeoutdelay');

const cfgPubSubMaxChanges = config.get('services.CoAuthoring.pubsub.maxChanges');

const cfgExpSaveLock = config.get('services.CoAuthoring.expire.saveLock');
const cfgExpLockDoc = config.get('services.CoAuthoring.expire.lockDoc');
const cfgExpSessionIdle = config.get('services.CoAuthoring.expire.sessionidle');
const cfgExpSessionAbsolute = config.get('services.CoAuthoring.expire.sessionabsolute');
const cfgExpSessionCloseCommand = config.get('services.CoAuthoring.expire.sessionclosecommand');
const cfgExpUpdateVersionStatus = config.get('services.CoAuthoring.expire.updateVersionStatus');
const cfgTokenEnableBrowser = config.get('services.CoAuthoring.token.enable.browser');
const cfgTokenEnableRequestInbox = config.get('services.CoAuthoring.token.enable.request.inbox');
const cfgTokenSessionAlgorithm = config.get('services.CoAuthoring.token.session.algorithm');
const cfgTokenSessionExpires = config.get('services.CoAuthoring.token.session.expires');
const cfgTokenInboxHeader = config.get('services.CoAuthoring.token.inbox.header');
const cfgTokenInboxPrefix = config.get('services.CoAuthoring.token.inbox.prefix');
const cfgTokenVerifyOptions = config.get('services.CoAuthoring.token.verifyOptions');
const cfgForceSaveEnable = config.get('services.CoAuthoring.autoAssembly.enable');
const cfgForceSaveInterval = config.get('services.CoAuthoring.autoAssembly.interval');
const cfgQueueRetentionPeriod = config.get('queue.retentionPeriod');
const cfgForgottenFiles = config.get('services.CoAuthoring.server.forgottenfiles');
const cfgForgottenFilesName = config.get('services.CoAuthoring.server.forgottenfilesname');
const cfgMaxRequestChanges = config.get('services.CoAuthoring.server.maxRequestChanges');
const cfgWarningLimitPercents = config.get('license.warning_limit_percents');
const cfgErrorFiles = config.get('FileConverter.converter.errorfiles');
const cfgOpenProtectedFile = config.get('services.CoAuthoring.server.openProtectedFile');
const cfgIsAnonymousSupport = config.get('services.CoAuthoring.server.isAnonymousSupport');
const cfgTokenRequiredParams = config.get('services.CoAuthoring.server.tokenRequiredParams');
const cfgImageSize = config.get('services.CoAuthoring.server.limits_image_size');
const cfgTypesUpload = config.get('services.CoAuthoring.utils.limits_image_types_upload');
const cfgExpDocumentsCron = config.get('services.CoAuthoring.expire.documentsCron');
const cfgRefreshLockInterval = ms(config.get('wopi.refreshLockInterval'));
const cfgSocketIoConnection = config.get('services.CoAuthoring.socketio.connection');
const cfgTableResult = config.get('services.CoAuthoring.sql.tableResult');

const EditorTypes = {
  document : 0,
  spreadsheet : 1,
  presentation : 2
};

const defaultHttpPort = 80, defaultHttpsPort = 443;	// Default ports (for http and https)
const editorData = new editorDataStorage();
const clientStatsD = statsDClient.getClient();
let connections = []; // Active connections
let lockDocumentsTimerId = {};//to drop connection that can't unlockDocument
let pubsub;
let queue;
let f = {type: constants.LICENSE_RESULT.Error, light: false, branding: false, customization: false, plugins: false};
let shutdownFlag = false;
let expDocumentsStep = gc.getCronStep(cfgExpDocumentsCron);

const MIN_SAVE_EXPIRATION = 60000;
const HEALTH_CHECK_KEY_MAX = 10000;
const SHARD_ID = crypto.randomBytes(16).toString('base64');//16 as guid

const PRECISION = [{name: 'hour', val: ms('1h')}, {name: 'day', val: ms('1d')}, {name: 'week', val: ms('7d')},
  {name: 'month', val: ms('31d')},
];

function getIsShutdown() {
  return shutdownFlag;
}

function getEditorConfig(ctx) {
  let tenEditor = ctx.getCfg('services.CoAuthoring.editor', cfgEditor);
  tenEditor = JSON.parse(JSON.stringify(tenEditor));
  tenEditor['reconnection']['delay'] = ms(tenEditor['reconnection']['delay']);
  tenEditor['websocketMaxPayloadSize'] = bytes.parse(tenEditor['websocketMaxPayloadSize']);
  tenEditor['maxChangesSize'] = bytes.parse(tenEditor['maxChangesSize']);
  return tenEditor;
}
function getForceSaveExpiration(ctx) {
  const tenForceSaveInterval = ms(ctx.getCfg('services.CoAuthoring.autoAssembly.interval', cfgForceSaveInterval));
  const tenQueueRetentionPeriod = ctx.getCfg('queue.retentionPeriod', cfgQueueRetentionPeriod);

  return Math.min(Math.max(tenForceSaveInterval, MIN_SAVE_EXPIRATION), tenQueueRetentionPeriod * 1000);
}

function DocumentChanges(docId) {
  this.docId = docId;
  this.arrChanges = [];

  return this;
}
DocumentChanges.prototype.getLength = function() {
  return this.arrChanges.length;
};
DocumentChanges.prototype.push = function(change) {
  this.arrChanges.push(change);
};
DocumentChanges.prototype.splice = function(start, deleteCount) {
  this.arrChanges.splice(start, deleteCount);
};
DocumentChanges.prototype.slice = function(start, end) {
  return this.arrChanges.splice(start, end);
};
DocumentChanges.prototype.concat = function(item) {
  this.arrChanges = this.arrChanges.concat(item);
};

const c_oAscServerStatus = {
  NotFound: 0,
  Editing: 1,
  MustSave: 2,
  Corrupted: 3,
  Closed: 4,
  MailMerge: 5,
  MustSaveForce: 6,
  CorruptedForce: 7
};

const c_oAscChangeBase = {
  No: 0,
  Delete: 1,
  All: 2
};

const c_oAscLockTimeOutDelay = 500;	// Timeout to save when database is clamped

const c_oAscRecalcIndexTypes = {
  RecalcIndexAdd: 1,
  RecalcIndexRemove: 2
};
const c_oAscLockTypes = {
  kLockTypeNone: 1, // no one has locked this object
  kLockTypeMine: 2, // this object is locked by the current user
  kLockTypeOther: 3, // this object is locked by another (not the current) user
  kLockTypeOther2: 4, // this object is locked by another (not the current) user (updates have already arrived)
  kLockTypeOther3: 5 // this object has been locked (updates have arrived) and is now locked again
};

const c_oAscLockTypeElem = {
  Range: 1,
  Object: 2,
  Sheet: 3
};
const c_oAscLockTypeElemSubType = {
  DeleteColumns: 1,
  InsertColumns: 2,
  DeleteRows: 3,
  InsertRows: 4,
  ChangeProperties: 5
};

const c_oAscLockTypeElemPresentation = {
  Object: 1,
  Slide: 2,
  Presentation: 3
};

function CRecalcIndexElement(recalcType, position, bIsSaveIndex) {
  if (!(this instanceof CRecalcIndexElement)) {
    return new CRecalcIndexElement(recalcType, position, bIsSaveIndex);
  }

  this._recalcType = recalcType; // Type of changes (removal or addition)
  this._position = position; // The position where the changes happened
  this._count = 1; // We consider all changes as the simplest
  this.m_bIsSaveIndex = !!bIsSaveIndex; // These are indexes from other users' changes (that we haven't applied yet)

  return this;
}

CRecalcIndexElement.prototype = {
  constructor: CRecalcIndexElement,
  getLockOther: function(position, type) {
    var inc = (c_oAscRecalcIndexTypes.RecalcIndexAdd === this._recalcType) ? +1 : -1;
    if (position === this._position && c_oAscRecalcIndexTypes.RecalcIndexRemove === this._recalcType &&
      true === this.m_bIsSaveIndex) {
      return null;
    } else if (position === this._position &&
      c_oAscRecalcIndexTypes.RecalcIndexRemove === this._recalcType &&
      c_oAscLockTypes.kLockTypeMine === type && false === this.m_bIsSaveIndex) {
      return null;
    } else if (position < this._position) {
      return position;
    }
    else {
      return (position + inc);
    }
  },
  getLockSaveOther: function(position, type) {
    if (this.m_bIsSaveIndex) {
      return position;
    }

    var inc = (c_oAscRecalcIndexTypes.RecalcIndexAdd === this._recalcType) ? +1 : -1;
    if (position === this._position && c_oAscRecalcIndexTypes.RecalcIndexRemove === this._recalcType &&
      true === this.m_bIsSaveIndex) {
      return null;
    } else if (position === this._position &&
      c_oAscRecalcIndexTypes.RecalcIndexRemove === this._recalcType &&
      c_oAscLockTypes.kLockTypeMine === type && false === this.m_bIsSaveIndex) {
      return null;
    } else if (position < this._position) {
      return position;
    }
    else {
      return (position + inc);
    }
  },
  getLockMe: function(position) {
    var inc = (c_oAscRecalcIndexTypes.RecalcIndexAdd === this._recalcType) ? -1 : +1;
    if (position < this._position) {
      return position;
    }
    else {
      return (position + inc);
    }
  },
  getLockMe2: function(position) {
    var inc = (c_oAscRecalcIndexTypes.RecalcIndexAdd === this._recalcType) ? -1 : +1;
    if (true !== this.m_bIsSaveIndex || position < this._position) {
      return position;
    }
    else {
      return (position + inc);
    }
  }
};

function CRecalcIndex() {
  if (!(this instanceof CRecalcIndex)) {
    return new CRecalcIndex();
  }

  this._arrElements = [];		// CRecalcIndexElement array

  return this;
}

CRecalcIndex.prototype = {
  constructor: CRecalcIndex,
  add: function(recalcType, position, count, bIsSaveIndex) {
    for (var i = 0; i < count; ++i)
      this._arrElements.push(new CRecalcIndexElement(recalcType, position, bIsSaveIndex));
  },
  clear: function() {
    this._arrElements.length = 0;
  },

  getLockOther: function(position, type) {
    var newPosition = position;
    var count = this._arrElements.length;
    for (var i = 0; i < count; ++i) {
      newPosition = this._arrElements[i].getLockOther(newPosition, type);
      if (null === newPosition) {
        break;
      }
    }

    return newPosition;
  },
  getLockSaveOther: function(position, type) {
    var newPosition = position;
    var count = this._arrElements.length;
    for (var i = 0; i < count; ++i) {
      newPosition = this._arrElements[i].getLockSaveOther(newPosition, type);
      if (null === newPosition) {
        break;
      }
    }

    return newPosition;
  },
  getLockMe: function(position) {
    var newPosition = position;
    var count = this._arrElements.length;
    for (var i = count - 1; i >= 0; --i) {
      newPosition = this._arrElements[i].getLockMe(newPosition);
      if (null === newPosition) {
        break;
      }
    }

    return newPosition;
  },
  getLockMe2: function(position) {
    var newPosition = position;
    var count = this._arrElements.length;
    for (var i = count - 1; i >= 0; --i) {
      newPosition = this._arrElements[i].getLockMe2(newPosition);
      if (null === newPosition) {
        break;
      }
    }

    return newPosition;
  }
};

function updatePresenceCounters(ctx, conn, val) {
  return co(function* () {
    let aggregationCtx;
    if (tenantManager.isMultitenantMode(ctx) && !tenantManager.isDefaultTenant(ctx)) {
      aggregationCtx = new operationContext.Context();
      aggregationCtx.init(tenantManager.getDefautTenant(), ctx.docId, ctx.userId);
    }
    if (utils.isLiveViewer(conn)) {
      yield editorData.incrLiveViewerConnectionsCountByShard(ctx, SHARD_ID, val);
      if (aggregationCtx) {
        yield editorData.incrLiveViewerConnectionsCountByShard(aggregationCtx, SHARD_ID, val);
      }
      if (clientStatsD) {
        let countLiveView = yield editorData.getLiveViewerConnectionsCount(ctx, connections);
        clientStatsD.gauge('expireDoc.connections.liveview', countLiveView);
      }
    } else if (conn.isCloseCoAuthoring || (conn.user && conn.user.view)) {
      yield editorData.incrViewerConnectionsCountByShard(ctx, SHARD_ID, val);
      if (aggregationCtx) {
        yield editorData.incrViewerConnectionsCountByShard(aggregationCtx, SHARD_ID, val);
      }
      if (clientStatsD) {
        let countView = yield editorData.getViewerConnectionsCount(ctx, connections);
        clientStatsD.gauge('expireDoc.connections.view', countView);
      }
    } else {
      yield editorData.incrEditorConnectionsCountByShard(ctx, SHARD_ID, val);
      if (aggregationCtx) {
        yield editorData.incrEditorConnectionsCountByShard(aggregationCtx, SHARD_ID, val);
      }
      if (clientStatsD) {
        let countEditors = yield editorData.getEditorConnectionsCount(ctx, connections);
        clientStatsD.gauge('expireDoc.connections.edit', countEditors);
      }
    }
  });
}
function addPresence(ctx, conn, updateCunters) {
  return co(function* () {
    yield editorData.addPresence(ctx, conn.docId, conn.user.id, utils.getConnectionInfoStr(conn));
    if (updateCunters) {
      yield updatePresenceCounters(ctx, conn, 1);
    }
  });
}
function removePresence(ctx, conn) {
  return co(function* () {
    yield editorData.removePresence(ctx, conn.docId, conn.user.id);
    yield updatePresenceCounters(ctx, conn, -1);
  });
}

let changeConnectionInfo = co.wrap(function*(ctx, conn, cmd) {
  if (!conn.denyChangeName && conn.user) {
    yield* publish(ctx, {type: commonDefines.c_oPublishType.changeConnecitonInfo, ctx: ctx, docId: conn.docId, useridoriginal: conn.user.idOriginal, cmd: cmd});
    return true;
  }
  return false;
});
function signToken(ctx, payload, algorithm, expiresIn, secretElem) {
  return co(function*() {
    var options = {algorithm: algorithm, expiresIn: expiresIn};
    let secret = yield tenantManager.getTenantSecret(ctx, secretElem);
    return jwt.sign(payload, secret, options);
  });
}
function needSendChanges (conn){
  return !conn.user?.view || utils.isLiveViewer(conn);
}
function fillJwtByConnection(ctx, conn) {
  return co(function*() {
    const tenTokenSessionAlgorithm = ctx.getCfg('services.CoAuthoring.token.session.algorithm', cfgTokenSessionAlgorithm);
    const tenTokenSessionExpires = ms(ctx.getCfg('services.CoAuthoring.token.session.expires', cfgTokenSessionExpires));

    var payload = {document: {}, editorConfig: {user: {}}};
    var doc = payload.document;
    doc.key = conn.docId;
    doc.permissions = conn.permissions;
    doc.ds_encrypted = conn.encrypted;
    var edit = payload.editorConfig;
    var user = edit.user;
    user.id = conn.user.idOriginal;
    user.name = conn.user.username;
    user.index = conn.user.indexUser;
    if (conn.coEditingMode) {
      edit.coEditing = {mode: conn.coEditingMode};
    }
    edit.ds_view = conn.user.view;
    edit.ds_isCloseCoAuthoring = conn.isCloseCoAuthoring;
    edit.ds_isEnterCorrectPassword = conn.isEnterCorrectPassword;
    edit.ds_sessionTimeConnect = conn.sessionTimeConnect;

    return yield signToken(ctx, payload, tenTokenSessionAlgorithm, tenTokenSessionExpires / 1000, commonDefines.c_oAscSecretType.Session);
  });
}

function sendData(ctx, conn, data) {
  conn.emit('message', data);
  const type = data ? data.type : null;
  ctx.logger.debug('sendData: type = %s', type);
}
function sendDataWarning(ctx, conn, msg) {
  sendData(ctx, conn, {type: "warning", message: msg});
}
function sendDataMessage(ctx, conn, msg) {
  if (!conn.permissions || false !== conn.permissions.chat) {
    sendData(ctx, conn, {type: "message", messages: msg});
  } else {
    ctx.logger.debug("sendDataMessage permissions.chat==false");
  }
}
function sendDataCursor(ctx, conn, msg) {
  sendData(ctx, conn, {type: "cursor", messages: msg});
}
function sendDataMeta(ctx, conn, msg) {
  sendData(ctx, conn, {type: "meta", messages: msg});
}
function sendDataSession(ctx, conn, msg) {
  sendData(ctx, conn, {type: "session", messages: msg});
}
function sendDataRefreshToken(ctx, conn, msg) {
  sendData(ctx, conn, {type: "refreshToken", messages: msg});
}
function sendDataRpc(ctx, conn, responseKey, data) {
  sendData(ctx, conn, {type: "rpc", responseKey: responseKey, data: data});
}
function sendDataDrop(ctx, conn, code, description) {
  sendData(ctx, conn, {type: "drop", code: code, description: description});
}
function sendDataDisconnectReason(ctx, conn, code, description) {
  sendData(ctx, conn, {type: "disconnectReason", code: code, description: description});
}

function sendReleaseLock(ctx, conn, userLocks) {
  sendData(ctx, conn, {type: "releaseLock", locks: _.map(userLocks, function(e) {
    return {
      block: e.block,
      user: e.user,
      time: Date.now(),
      changes: null
    };
  })});
}
function modifyConnectionForPassword(ctx, conn, isEnterCorrectPassword) {
  return co(function*() {
    const tenTokenEnableBrowser = ctx.getCfg('services.CoAuthoring.token.enable.browser', cfgTokenEnableBrowser);
    if (isEnterCorrectPassword) {
      conn.isEnterCorrectPassword = true;
      if (tenTokenEnableBrowser) {
        let sessionToken = yield fillJwtByConnection(ctx, conn);
        sendDataRefreshToken(ctx, conn, sessionToken);
      }
    }
  });
}
function getParticipants(docId, excludeClosed, excludeUserId, excludeViewer) {
  return _.filter(connections, function(el) {
    return el.docId === docId && el.isCloseCoAuthoring !== excludeClosed &&
      el.user.id !== excludeUserId && el.user.view !== excludeViewer;
  });
}
function getParticipantUser(docId, includeUserId) {
  return _.filter(connections, function(el) {
    return el.docId === docId && el.user.id === includeUserId;
  });
}


function* updateEditUsers(ctx, licenseInfo, userId, anonym, isLiveViewer) {
  if (!licenseInfo.usersCount) {
    return;
  }
  const now = new Date();
  const expireAt = (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)) / 1000 +
      licenseInfo.usersExpire - 1;
  let period = utils.getLicensePeriod(licenseInfo.startDate, now);
  if (isLiveViewer) {
    yield editorData.addPresenceUniqueViewUser(ctx, userId, expireAt, {anonym: anonym});
    yield editorData.addPresenceUniqueViewUsersOfMonth(ctx, userId, period, {anonym: anonym, firstOpenDate: now.toISOString()});
  } else {
    yield editorData.addPresenceUniqueUser(ctx, userId, expireAt, {anonym: anonym});
    yield editorData.addPresenceUniqueUsersOfMonth(ctx, userId, period, {anonym: anonym, firstOpenDate: now.toISOString()});
  }
}
function* getEditorsCount(ctx, docId, opt_hvals) {
  var elem, editorsCount = 0;
  var hvals;
  if(opt_hvals){
    hvals = opt_hvals;
  } else {
    hvals = yield editorData.getPresence(ctx, docId, connections);
  }
  for (var i = 0; i < hvals.length; ++i) {
    elem = JSON.parse(hvals[i]);
    if(!elem.view && !elem.isCloseCoAuthoring) {
      editorsCount++;
      break;
    }
  }
  return editorsCount;
}
function* hasEditors(ctx, docId, opt_hvals) {
  let editorsCount = yield* getEditorsCount(ctx, docId, opt_hvals);
  return editorsCount > 0;
}
function* isUserReconnect(ctx, docId, userId, connectionId) {
  var elem;
  var hvals = yield editorData.getPresence(ctx, docId, connections);
  for (var i = 0; i < hvals.length; ++i) {
    elem = JSON.parse(hvals[i]);
    if (userId === elem.id && connectionId !== elem.connectionId) {
      return true;
    }
  }
  return false;
}

let pubsubOnMessage = null;//todo move function
function* publish(ctx, data, optDocId, optUserId, opt_pubsub) {
  var needPublish = true;
  let hvals;
  if (optDocId && optUserId) {
    needPublish = false;
    hvals = yield editorData.getPresence(ctx, optDocId, connections);
    for (var i = 0; i < hvals.length; ++i) {
      var elem = JSON.parse(hvals[i]);
      if (optUserId != elem.id) {
        needPublish = true;
        break;
      }
    }
  }
  if (needPublish) {
    var msg = JSON.stringify(data);
    var realPubsub = opt_pubsub ? opt_pubsub : pubsub;
    if (pubsubOnMessage && hvals && hvals.length === getLocalConnectionCount(ctx, optDocId)) {
      ctx.logger.debug("pubsub locally");
      pubsubOnMessage(msg);
    } else if(realPubsub) {
      yield realPubsub.publish(msg);
    }
  }
  return needPublish;
}
function* addTask(data, priority, opt_queue, opt_expiration) {
  var realQueue = opt_queue ? opt_queue : queue;
  yield realQueue.addTask(data, priority, opt_expiration);
}
function* addResponse(data, opt_queue) {
  var realQueue = opt_queue ? opt_queue : queue;
  yield realQueue.addResponse(data);
}
function* addDelayed(data, ttl, opt_queue) {
  var realQueue = opt_queue ? opt_queue : queue;
  yield realQueue.addDelayed(data, ttl);
}
function* removeResponse(data) {
  yield queue.removeResponse(data);
}

function* getOriginalParticipantsId(ctx, docId) {
  var result = [], tmpObject = {};
  var hvals = yield editorData.getPresence(ctx, docId, connections);
  for (var i = 0; i < hvals.length; ++i) {
    var elem = JSON.parse(hvals[i]);
    if (!elem.view && !elem.isCloseCoAuthoring) {
      tmpObject[elem.idOriginal] = 1;
    }
  }
  for (var name in tmpObject) if (tmpObject.hasOwnProperty(name)) {
    result.push(name);
  }
  return result;
}

function* sendServerRequest(ctx, uri, dataObject, opt_checkAndFixAuthorizationLength) {
  const tenCallbackRequestTimeout = ctx.getCfg('services.CoAuthoring.server.callbackRequestTimeout', cfgCallbackRequestTimeout);

  ctx.logger.debug('postData request: url = %s;data = %j', uri, dataObject);
  let auth;
  if (utils.canIncludeOutboxAuthorization(ctx, uri)) {
    let secret = yield tenantManager.getTenantSecret(ctx, commonDefines.c_oAscSecretType.Outbox);
    let bodyToken = utils.fillJwtForRequest(ctx, dataObject, secret, true);
    auth = utils.fillJwtForRequest(ctx, dataObject, secret, false);
    let authLen = auth.length;
    if (opt_checkAndFixAuthorizationLength && !opt_checkAndFixAuthorizationLength(auth, dataObject)) {
      auth = utils.fillJwtForRequest(ctx, dataObject, secret, false);
      ctx.logger.warn('authorization too large. Use body token instead. size reduced from %d to %d', authLen, auth.length);
    }
    dataObject.setToken(bodyToken);
  }
  let postRes = yield utils.postRequestPromise(ctx, uri, JSON.stringify(dataObject), undefined, undefined, tenCallbackRequestTimeout, auth);
  ctx.logger.debug('postData response: data = %s', postRes.body);
  return postRes.body;
}

function parseUrl(ctx, callbackUrl) {
  var result = null;
  try {
    var parseObject = url.parse(callbackUrl);
    var isHttps = 'https:' === parseObject.protocol;
    var port = parseObject.port;
    if (!port) {
      port = isHttps ? defaultHttpsPort : defaultHttpPort;
    }
    result = {
      'https': isHttps,
      'host': parseObject.hostname,
      'port': port,
      'path': parseObject.path,
      'href': parseObject.href
    };
  } catch (e) {
    ctx.logger.error("error parseUrl %s: %s", callbackUrl, e.stack);
    result = null;
  }

  return result;
}

function* getCallback(ctx, id, opt_userIndex) {
  var callbackUrl = null;
  var baseUrl = null;
  let wopiParams = null;
  var selectRes = yield taskResult.select(ctx, id);
  if (selectRes.length > 0) {
    var row = selectRes[0];
    if (row.callback) {
      callbackUrl = sqlBase.UserCallback.prototype.getCallbackByUserIndex(ctx, row.callback, opt_userIndex);
      wopiParams = wopiClient.parseWopiCallback(ctx, callbackUrl, row.callback);
    }
    if (row.baseurl) {
      baseUrl = row.baseurl;
    }
  }
  if (null != callbackUrl && null != baseUrl) {
    return {server: parseUrl(ctx, callbackUrl), baseUrl: baseUrl, wopiParams: wopiParams};
  } else {
    return null;
  }
}
function* getChangesIndex(ctx, docId) {
  var res = 0;
  var getRes = yield sqlBase.getChangesIndexPromise(ctx, docId);
  if (getRes && getRes.length > 0 && null != getRes[0]['change_id']) {
    res = getRes[0]['change_id'] + 1;
  }
  return res;
}

const hasChanges = co.wrap(function*(ctx, docId) {
  let puckerIndex = yield* getChangesIndex(ctx, docId);
  if (0 === puckerIndex) {
    let selectRes = yield taskResult.select(ctx, docId);
    if (selectRes.length > 0 && selectRes[0].password) {
      return sqlBase.DocumentPassword.prototype.hasPasswordChanges(ctx, selectRes[0].password);
    }
    return false;
  }
  return true;
});
function* setForceSave(ctx, docId, forceSave, cmd, success, url) {
  let forceSaveType = forceSave.getType();
  let end = success;
  if (commonDefines.c_oAscForceSaveTypes.Form === forceSaveType || commonDefines.c_oAscForceSaveTypes.Internal === forceSaveType) {
    let forceSave = yield editorData.getForceSave(ctx, docId);
    end = forceSave.ended;
  }
  let convertInfo = new commonDefines.InputCommand(cmd, true);
  convertInfo.setUserConnectionDocId(undefined);
  convertInfo.setUserConnectionId(undefined);
  convertInfo.setResponseKey(undefined);
  convertInfo.setFormData(undefined);
  if (convertInfo.getForceSave()) {
    convertInfo.getForceSave().setType(undefined);
  }
  yield editorData.checkAndSetForceSave(ctx, docId, forceSave.getTime(), forceSave.getIndex(), end, end, convertInfo);

  if (commonDefines.c_oAscForceSaveTypes.Command !== forceSaveType) {
    let data = {type: forceSaveType, time: forceSave.getTime(), success: success};
    if(commonDefines.c_oAscForceSaveTypes.Form === forceSaveType || commonDefines.c_oAscForceSaveTypes.Internal === forceSaveType) {
      data = {code: commonDefines.c_oAscServerCommandErrors.NoError, time: null, inProgress: false};
      if (commonDefines.c_oAscForceSaveTypes.Internal === forceSaveType) {
        data.url = url;
      }
      let userId = cmd.getUserConnectionId();
      docId = cmd.getUserConnectionDocId() || docId;
      yield* publish(ctx, {type: commonDefines.c_oPublishType.rpc, ctx, docId, userId, data, responseKey: cmd.getResponseKey()});
    } else {
      yield* publish(ctx, {type: commonDefines.c_oPublishType.forceSave, ctx: ctx, docId: docId, data: data}, cmd.getUserConnectionId());
    }
  }
}
async function checkForceSaveCache(ctx, convertInfo) {
  let res = {hasCache: false, hasValidCache: false,  cmd: null};
  if (convertInfo) {
    res.hasCache = true;
    let cmd = new commonDefines.InputCommand(convertInfo, true);
    const saveKey = cmd.getSaveKey();
    const outputPath = cmd.getOutputPath();
    if (saveKey && outputPath) {
      const savePathDoc = saveKey + '/' + outputPath;
      const metadata  = await storage.headObject(ctx, savePathDoc);
      res.hasValidCache = !!metadata;
      res.cmd = cmd;
    }
  }
  return res;
}
async function applyForceSaveCache(ctx, docId, forceSave, type, opt_userConnectionId, opt_userConnectionDocId,
                                   opt_responseKey, opt_formdata) {
  let res = {ok: false, notModified: false, inProgress: false, startedForceSave: null};
  if (!forceSave) {
    res.notModified = true;
    return res;
  }
  let forceSaveCache = await checkForceSaveCache(ctx, forceSave.convertInfo);
  if (forceSaveCache.hasCache || forceSave.ended) {
    if (commonDefines.c_oAscForceSaveTypes.Form === type || commonDefines.c_oAscForceSaveTypes.Internal === type || !forceSave.ended) {
      if (forceSaveCache.hasValidCache) {
        let cmd = forceSaveCache.cmd;
        cmd.setUserConnectionDocId(opt_userConnectionDocId);
        cmd.setUserConnectionId(opt_userConnectionId);
        cmd.setResponseKey(opt_responseKey);
        cmd.setFormData(opt_formdata);
        if (cmd.getForceSave()) {
          cmd.getForceSave().setType(type);
        }
        await canvasService.commandSfcCallback(ctx, cmd, true, false);
        res.ok = true;
      } else {
        await editorData.checkAndSetForceSave(ctx, docId, forceSave.getTime(), forceSave.getIndex(), false, false, null);
        res.startedForceSave = await editorData.checkAndStartForceSave(ctx, docId);
        res.ok = !!res.startedForceSave;
      }
    } else {
      res.notModified = true;
    }
  } else if (!forceSave.started) {
      res.startedForceSave = await editorData.checkAndStartForceSave(ctx, docId);
      res.ok = !!res.startedForceSave;
      return res;
  } else if (commonDefines.c_oAscForceSaveTypes.Form === type || commonDefines.c_oAscForceSaveTypes.Internal === type) {
    res.ok = true;
    res.inProgress = true;
  } else {
    res.notModified = true;
  }
  return res;
}
async function startForceSave(ctx, docId, type, opt_userdata, opt_formdata, opt_userId, opt_userConnectionId, opt_userConnectionDocId, opt_userIndex, opt_responseKey, opt_baseUrl, opt_queue, opt_pubsub, opt_conn) {
  ctx.logger.debug('startForceSave start');
  let res = {code: commonDefines.c_oAscServerCommandErrors.NoError, time: null, inProgress: false};
  let startedForceSave;
  let hasEncrypted = false;
  if (!shutdownFlag) {
    let hvals = await editorData.getPresence(ctx, docId, connections);
    hasEncrypted = hvals.some((currentValue) => {
      return !!JSON.parse(currentValue).encrypted;
    });
    if (!hasEncrypted) {
      let forceSave = await editorData.getForceSave(ctx, docId);
      if (!forceSave && commonDefines.c_oAscForceSaveTypes.Form === type && opt_conn) {
        let newChangesLastDate = new Date();
        newChangesLastDate.setMilliseconds(0);//remove milliseconds avoid issues with MySQL datetime rounding
        let newChangesLastTime = newChangesLastDate.getTime();
        let baseUrl = utils.getBaseUrlByConnection(ctx, opt_conn);
        let changeInfo = getExternalChangeInfo(opt_conn.user, newChangesLastTime);
        await editorData.setForceSave(ctx, docId, newChangesLastTime, 0, baseUrl, changeInfo, null);
        forceSave = await editorData.getForceSave(ctx, docId);
      }
      let applyCacheRes = await applyForceSaveCache(ctx, docId, forceSave, type, opt_userConnectionId, opt_userConnectionDocId, opt_responseKey, opt_formdata);
      startedForceSave = applyCacheRes.startedForceSave;
      if (applyCacheRes.notModified) {
        let selectRes = await taskResult.select(ctx, docId);
        if (selectRes.length > 0) {
          res.code = commonDefines.c_oAscServerCommandErrors.NotModified;
        } else {
          res.code = commonDefines.c_oAscServerCommandErrors.DocumentIdError;
        }
      } else if (!applyCacheRes.ok) {
        res.code = commonDefines.c_oAscServerCommandErrors.UnknownError;
      }
      res.inProgress = applyCacheRes.inProgress;
    }
  }

  ctx.logger.debug('startForceSave canStart: hasEncrypted = %s; applyCacheRes = %j; startedForceSave = %j', hasEncrypted, res, startedForceSave);
  if (startedForceSave) {
    let baseUrl = opt_baseUrl || startedForceSave.baseUrl;
    let forceSave = new commonDefines.CForceSaveData(startedForceSave);
    forceSave.setType(type);
    forceSave.setAuthorUserId(opt_userId);
    forceSave.setAuthorUserIndex(opt_userIndex);

    if (commonDefines.c_oAscForceSaveTypes.Timeout === type) {
      await co(publish(ctx, {
                       type: commonDefines.c_oPublishType.forceSave, ctx: ctx, docId: docId,
                       data: {type: type, time: forceSave.getTime(), start: true}
                     }, undefined, undefined, opt_pubsub));
    }

    let priority;
    let expiration;
    if (commonDefines.c_oAscForceSaveTypes.Timeout === type) {
      priority = constants.QUEUE_PRIORITY_VERY_LOW;
      expiration = getForceSaveExpiration(ctx);
    } else {
      priority = constants.QUEUE_PRIORITY_LOW;
    }
    let status = await converterService.convertFromChanges(ctx, docId, baseUrl, forceSave, startedForceSave.changeInfo,
      opt_userdata, opt_formdata, opt_userConnectionId, opt_userConnectionDocId, opt_responseKey, priority, expiration,
      opt_queue);
    if (constants.NO_ERROR === status.err) {
      res.time = forceSave.getTime();
    } else {
      res.code = commonDefines.c_oAscServerCommandErrors.UnknownError;
    }
    ctx.logger.debug('startForceSave convertFromChanges: status = %d', status.err);
  }
  ctx.logger.debug('startForceSave end');
  return res;
}
function getExternalChangeInfo(user, date) {
  return {user_id: user.id, user_id_original: user.idOriginal, user_name: user.username, change_date: date};
}
let resetForceSaveAfterChanges = co.wrap(function*(ctx, docId, newChangesLastTime, puckerIndex, baseUrl, changeInfo) {
  const tenForceSaveEnable = ctx.getCfg('services.CoAuthoring.autoAssembly.enable', cfgForceSaveEnable);
  const tenForceSaveInterval = ms(ctx.getCfg('services.CoAuthoring.autoAssembly.interval', cfgForceSaveInterval));
  if (newChangesLastTime) {
    yield editorData.setForceSave(ctx, docId, newChangesLastTime, puckerIndex, baseUrl, changeInfo, null);
    if (tenForceSaveEnable) {
      let expireAt = newChangesLastTime + tenForceSaveInterval;
      yield editorData.addForceSaveTimerNX(ctx, docId, expireAt);
    }
  }
});
let saveRelativeFromChanges = co.wrap(function*(ctx, conn, responseKey, data) {
  const tenTokenEnableBrowser = ctx.getCfg('services.CoAuthoring.token.enable.browser', cfgTokenEnableBrowser);

  let docId = data.docId;
  let token = data.token;
  let forceSaveRes;
  if (tenTokenEnableBrowser) {
    docId = null;
    let checkJwtRes = yield checkJwt(ctx, token, commonDefines.c_oAscSecretType.Browser);
    if (checkJwtRes.decoded) {
      docId = checkJwtRes.decoded.key;
    } else {
      ctx.logger.warn('Error saveRelativeFromChanges jwt: %s', checkJwtRes.description);
      forceSaveRes = {code: commonDefines.c_oAscServerCommandErrors.Token, time: null, inProgress: false};
    }
  }
  if (!forceSaveRes) {
    forceSaveRes = yield startForceSave(ctx, docId, commonDefines.c_oAscForceSaveTypes.Internal, undefined, undefined, undefined, conn.user.id, conn.docId, undefined, responseKey);
  }
  if (commonDefines.c_oAscServerCommandErrors.NoError !== forceSaveRes.code || forceSaveRes.inProgress) {
    sendDataRpc(ctx, conn, responseKey, forceSaveRes);
  }
})
function* startRPC(ctx, conn, responseKey, data) {
  let docId = conn.docId;
  ctx.logger.debug('startRPC start responseKey:%s , %j', responseKey, data);
  switch (data.type) {
    case 'sendForm': {
      let forceSaveRes;
      if (conn.user) {
        forceSaveRes = yield startForceSave(ctx, docId, commonDefines.c_oAscForceSaveTypes.Form, undefined,
          data.formdata, conn.user.idOriginal, conn.user.id, undefined, conn.user.indexUser,
          responseKey, undefined, undefined, undefined, conn);
      }
      if (!forceSaveRes || commonDefines.c_oAscServerCommandErrors.NoError !== forceSaveRes.code || forceSaveRes.inProgress) {
        sendDataRpc(ctx, conn, responseKey, forceSaveRes);
      }
      break;
    }
    case 'saveRelativeFromChanges': {
      yield saveRelativeFromChanges(ctx, conn, responseKey, data);
      break;
    }
    case 'wopi_RenameFile':
      let renameRes;
      let selectRes = yield taskResult.select(ctx, docId);
      let row = selectRes.length > 0 ? selectRes[0] : null;
      if (row) {
        if (row.callback) {
          let userIndex = utils.getIndexFromUserId(conn.user.id, conn.user.idOriginal);
          let uri = sqlBase.UserCallback.prototype.getCallbackByUserIndex(ctx, row.callback, userIndex);
          let wopiParams = wopiClient.parseWopiCallback(ctx, uri, row.callback);
          if (wopiParams) {
            renameRes = yield wopiClient.renameFile(ctx, wopiParams, data.name);
          }
        }
      }
      sendDataRpc(ctx, conn, responseKey, renameRes);
      break;
    case 'pathurls':
      let outputData = new canvasService.OutputData(data.type);
      yield* canvasService.commandPathUrls(ctx, conn, data.data, outputData);
      sendDataRpc(ctx, conn, responseKey, outputData);
      break;
  }
  ctx.logger.debug('startRPC end');
}
function handleDeadLetter(data, ack) {
  return co(function*() {
    let ctx = new operationContext.Context();
    try {
      var isRequeued = false;
      let task = new commonDefines.TaskQueueData(JSON.parse(data));
      if (task) {
        ctx.initFromTaskQueueData(task);
        yield ctx.initTenantCache();
        let cmd = task.getCmd();
        ctx.logger.warn('handleDeadLetter start: %s', data);
        let forceSave = cmd.getForceSave();
        if (forceSave && commonDefines.c_oAscForceSaveTypes.Timeout == forceSave.getType()) {
          let actualForceSave = yield editorData.getForceSave(ctx, cmd.getDocId());
          if (actualForceSave && forceSave.getTime() === actualForceSave.time && forceSave.getIndex() === actualForceSave.index) {
            yield* addTask(task, constants.QUEUE_PRIORITY_VERY_LOW, undefined, getForceSaveExpiration(ctx));
            isRequeued = true;
          }
        } else if (!forceSave && task.getFromChanges()) {
          yield* addTask(task, constants.QUEUE_PRIORITY_NORMAL, undefined);
          isRequeued = true;
        } else if(cmd.getAttempt()) {
          ctx.logger.warn('handleDeadLetter addResponse delayed = %d', cmd.getAttempt());
          yield* addResponse(task);
        } else {
          cmd.setStatusInfo(constants.CONVERT_DEAD_LETTER);
          canvasService.receiveTask(JSON.stringify(task), function(){});
        }
      }
      ctx.logger.warn('handleDeadLetter end: requeue = %s', isRequeued);
    } catch (err) {
      ctx.logger.error('handleDeadLetter error: %s', err.stack);
    } finally {
      ack();
    }
  });
}
function* sendStatusDocument(ctx, docId, bChangeBase, opt_userAction, opt_userIndex, opt_callback, opt_baseUrl, opt_userData, opt_forceClose) {
  if (!opt_callback) {
    var getRes = yield* getCallback(ctx, docId, opt_userIndex);
    if (getRes) {
      opt_callback = getRes.server;
      if (!opt_baseUrl) {
        opt_baseUrl = getRes.baseUrl;
      }
      if (getRes.wopiParams) {
        ctx.logger.debug('sendStatusDocument wopi stub');
        return opt_callback;
      }
    }
  }
  if (null == opt_callback) {
    return;
  }

  var status = c_oAscServerStatus.Editing;
  var participants = yield* getOriginalParticipantsId(ctx, docId);
  if (0 === participants.length) {
    let bHasChanges = yield hasChanges(ctx, docId);
    if (!bHasChanges || opt_forceClose) {
      status = c_oAscServerStatus.Closed;
    }
  }

  if (c_oAscChangeBase.No !== bChangeBase) {
    if (c_oAscChangeBase.All === bChangeBase) {
      var updateTask = new taskResult.TaskResultData();
      updateTask.tenant = ctx.tenant;
      updateTask.key = docId;
      updateTask.callback = opt_callback.href;
      updateTask.baseurl = opt_baseUrl;
      var updateIfRes = yield taskResult.update(ctx, updateTask);
      if (updateIfRes.affectedRows > 0) {
        ctx.logger.debug('sendStatusDocument updateIf');
      } else {
        ctx.logger.debug('sendStatusDocument updateIf no effect');
      }
    }
  }

  var sendData = new commonDefines.OutputSfcData(docId);
  sendData.setStatus(status);
  if (c_oAscServerStatus.Closed !== status) {
    sendData.setUsers(participants);
  }
  if (opt_userAction) {
    sendData.setActions([opt_userAction]);
  }
  if (opt_userData) {
    sendData.setUserData(opt_userData);
  }
  var uri = opt_callback.href;
  var replyData = null;
  try {
    replyData = yield* sendServerRequest(ctx, uri, sendData);
  } catch (err) {
    replyData = null;
    ctx.logger.error('postData error: url = %s;data = %j %s', uri, sendData, err.stack);
  }
  yield* onReplySendStatusDocument(ctx, docId, replyData);
  return opt_callback;
}
function parseReplyData(ctx, replyData) {
  var res = null;
  if (replyData) {
    try {
      res = JSON.parse(replyData);
    } catch (e) {
      ctx.logger.error("error parseReplyData: data = %s %s", replyData, e.stack);
      res = null;
    }
  }
  return res;
}
function* onReplySendStatusDocument(ctx, docId, replyData) {
  var oData = parseReplyData(ctx, replyData);
  if (!(oData && commonDefines.c_oAscServerCommandErrors.NoError == oData.error)) {
    yield* publish(ctx, {type: commonDefines.c_oPublishType.warning, ctx: ctx, docId: docId, description: 'Error on save server subscription!'});
  }
}
function* publishCloseUsersConnection(ctx, docId, users, isOriginalId, code, description) {
  if (Array.isArray(users)) {
    let usersMap = users.reduce(function(map, val) {
      map[val] = 1;
      return map;
    }, {});
    yield* publish(ctx, {
                     type: commonDefines.c_oPublishType.closeConnection, ctx: ctx, docId: docId, usersMap: usersMap,
                     isOriginalId: isOriginalId, code: code, description: description
                   });
  }
}
function closeUsersConnection(ctx, docId, usersMap, isOriginalId, code, description) {
  let conn;
  for (let i = connections.length - 1; i >= 0; --i) {
    conn = connections[i];
    if (conn.docId === docId) {
      if (isOriginalId ? usersMap[conn.user.idOriginal] : usersMap[conn.user.id]) {
        sendDataDisconnectReason(ctx, conn, code, description);
        conn.disconnect(true);
      }
    }
  }
}
function* dropUsersFromDocument(ctx, docId, users) {
  if (Array.isArray(users)) {
    yield* publish(ctx, {type: commonDefines.c_oPublishType.drop, ctx: ctx, docId: docId, users: users, description: ''});
  }
}

function dropUserFromDocument(ctx, docId, userId, description) {
  var elConnection;
  for (var i = 0, length = connections.length; i < length; ++i) {
    elConnection = connections[i];
    if (elConnection.docId === docId && userId === elConnection.user.idOriginal && !elConnection.isCloseCoAuthoring) {
      sendDataDrop(ctx, elConnection, description);
    }
  }
}
function getLocalConnectionCount(ctx, docId) {
  let tenant = ctx.tenant;
  return connections.reduce(function(count, conn) {
    if (conn.docId === docId && conn.tenant === ctx.tenant) {
      count++;
    }
    return count;
  }, 0);
}
function* bindEvents(ctx, docId, callback, baseUrl, opt_userAction, opt_userData) {
  var bChangeBase;
  var oCallbackUrl;
  if (!callback) {
    var getRes = yield* getCallback(ctx, docId);
    if (getRes && !getRes.wopiParams) {
      oCallbackUrl = getRes.server;
      bChangeBase = c_oAscChangeBase.Delete;
    }
  } else {
    oCallbackUrl = parseUrl(ctx, callback);
    bChangeBase = c_oAscChangeBase.All;
    if (null !== oCallbackUrl) {
      let filterStatus = yield* utils.checkHostFilter(ctx, oCallbackUrl.host);
      if (filterStatus > 0) {
        ctx.logger.warn('checkIpFilter error: url = %s', callback);
        oCallbackUrl = null;
      }
    }
  }
  if (null === oCallbackUrl) {
    return commonDefines.c_oAscServerCommandErrors.ParseError;
  } else {
    yield* sendStatusDocument(ctx, docId, bChangeBase, opt_userAction, undefined, oCallbackUrl, baseUrl, opt_userData);
    return commonDefines.c_oAscServerCommandErrors.NoError;
  }
}
let unlockWopiDoc = co.wrap(function*(ctx, docId, opt_userIndex) {
  var getRes = yield* getCallback(ctx, docId, opt_userIndex);
  if (getRes && getRes.wopiParams && getRes.wopiParams.userAuth && 'view' !== getRes.wopiParams.userAuth.mode) {
    yield wopiClient.unlock(ctx, getRes.wopiParams);
    let unlockInfo = wopiClient.getWopiUnlockMarker(getRes.wopiParams);
    if (unlockInfo) {
      yield canvasService.commandOpenStartPromise(ctx, docId, undefined, true, unlockInfo);
    }
  }
});
function* cleanDocumentOnExit(ctx, docId, deleteChanges, opt_userIndex) {
  const tenForgottenFiles = ctx.getCfg('services.CoAuthoring.server.forgottenfiles', cfgForgottenFiles);
  yield editorData.cleanDocumentOnExit(ctx, docId);
  if (deleteChanges) {
    yield taskResult.restoreInitialPassword(ctx, docId);
    sqlBase.deleteChanges(ctx, docId, null);
    yield storage.deletePath(ctx, docId, tenForgottenFiles);
  }
  yield unlockWopiDoc(ctx, docId, opt_userIndex);
}
function* cleanDocumentOnExitNoChanges(ctx, docId, opt_userId, opt_userIndex, opt_forceClose) {
  var userAction = opt_userId ? new commonDefines.OutputAction(commonDefines.c_oAscUserAction.Out, opt_userId) : null;
  yield* sendStatusDocument(ctx, docId, c_oAscChangeBase.No, userAction, opt_userIndex, undefined, undefined, undefined, opt_forceClose);
  yield* cleanDocumentOnExit(ctx, docId, false, opt_userIndex);
}

function createSaveTimer(ctx, docId, opt_userId, opt_userIndex, opt_queue, opt_noDelay) {
  return co(function*(){
    const tenAscSaveTimeOutDelay = ctx.getCfg('services.CoAuthoring.server.savetimeoutdelay', cfgAscSaveTimeOutDelay);

    var updateMask = new taskResult.TaskResultData();
    updateMask.tenant = ctx.tenant;
    updateMask.key = docId;
    updateMask.status = commonDefines.FileStatus.Ok;
    var updateTask = new taskResult.TaskResultData();
    updateTask.status = commonDefines.FileStatus.SaveVersion;
    updateTask.statusInfo = utils.getMillisecondsOfHour(new Date());
    var updateIfRes = yield taskResult.updateIf(ctx, updateTask, updateMask);
    if (updateIfRes.affectedRows > 0) {
      if(!opt_noDelay){
        yield utils.sleep(tenAscSaveTimeOutDelay);
      }
      while (true) {
        if (!sqlBase.isLockCriticalSection(docId)) {
          canvasService.saveFromChanges(ctx, docId, updateTask.statusInfo, null, opt_userId, opt_userIndex, opt_queue);
          break;
        }
        yield utils.sleep(c_oAscLockTimeOutDelay);
      }
    } else {
      ctx.logger.debug('createSaveTimer updateIf no effect');
    }
  });
}

function checkJwt(ctx, token, type) {
  return co(function*() {
    const tenTokenVerifyOptions = ctx.getCfg('services.CoAuthoring.token.verifyOptions', cfgTokenVerifyOptions);

    var res = {decoded: null, description: null, code: null, token: token};
    let secret = yield tenantManager.getTenantSecret(ctx, type);
    if (undefined == secret) {
      ctx.logger.warn('empty secret: token = %s', token);
    }
    try {
      res.decoded = jwt.verify(token, secret, tenTokenVerifyOptions);
      ctx.logger.debug('checkJwt success: decoded = %j', res.decoded);
    } catch (err) {
      ctx.logger.warn('checkJwt error: name = %s message = %s token = %s', err.name, err.message, token);
      if ('TokenExpiredError' === err.name) {
        res.code = constants.JWT_EXPIRED_CODE;
        res.description = constants.JWT_EXPIRED_REASON + err.message;
      } else if ('JsonWebTokenError' === err.name) {
        res.code = constants.JWT_ERROR_CODE;
        res.description = constants.JWT_ERROR_REASON + err.message;
      }
    }
    return res;
  });
}
function checkJwtHeader(ctx, req, opt_header, opt_prefix, opt_secretType) {
  return co(function*() {
    const tenTokenInboxHeader = ctx.getCfg('services.CoAuthoring.token.inbox.header', cfgTokenInboxHeader);
    const tenTokenInboxPrefix = ctx.getCfg('services.CoAuthoring.token.inbox.prefix', cfgTokenInboxPrefix);

    let header = opt_header || tenTokenInboxHeader;
    let prefix = opt_prefix || tenTokenInboxPrefix;
    let secretType = opt_secretType || commonDefines.c_oAscSecretType.Inbox;
    let authorization = req.get(header);
    if (authorization && authorization.startsWith(prefix)) {
      var token = authorization.substring(prefix.length);
      return yield checkJwt(ctx, token, secretType);
    }
    return null;
  });
}
function getRequestParams(ctx, req, opt_isNotInBody) {
  return co(function*(){
    const tenTokenEnableRequestInbox = ctx.getCfg('services.CoAuthoring.token.enable.request.inbox', cfgTokenEnableRequestInbox);
    const tenTokenRequiredParams = ctx.getCfg('services.CoAuthoring.server.tokenRequiredParams', cfgTokenRequiredParams);

    let res = {code: constants.NO_ERROR, isDecoded: false, params: undefined};
    if (req.body && Buffer.isBuffer(req.body) && req.body.length > 0 && !opt_isNotInBody) {
      res.params = JSON.parse(req.body.toString('utf8'));
    } else {
      res.params = req.query;
    }
    if (tenTokenEnableRequestInbox) {
      res.code = constants.VKEY;
      let checkJwtRes;
      if (res.params.token) {
        checkJwtRes = yield checkJwt(ctx, res.params.token, commonDefines.c_oAscSecretType.Inbox);
      } else {
        checkJwtRes = yield checkJwtHeader(ctx, req);
      }
      if (checkJwtRes) {
        if (checkJwtRes.decoded) {
          res.code = constants.NO_ERROR;
          res.isDecoded = true;
          if (tenTokenRequiredParams) {
            res.params = {};
          }
          Object.assign(res.params, checkJwtRes.decoded);
          if (!utils.isEmptyObject(checkJwtRes.decoded.payload)) {
            Object.assign(res.params, checkJwtRes.decoded.payload);
          }
          if (!utils.isEmptyObject(checkJwtRes.decoded.query)) {
            Object.assign(res.params, checkJwtRes.decoded.query);
          }
        } else if (constants.JWT_EXPIRED_CODE == checkJwtRes.code) {
          res.code = constants.VKEY_KEY_EXPIRE;
        }
      }
    }
    return res;
  });
}

function getLicenseNowUtc() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(),
                  now.getUTCMinutes(), now.getUTCSeconds()) / 1000;
}
let getParticipantMap = co.wrap(function*(ctx, docId, opt_hvals) {
  const participantsMap = [];
  let hvals;
  if (opt_hvals) {
    hvals = opt_hvals;
  } else {
    hvals = yield editorData.getPresence(ctx, docId, connections);
  }
  for (let i = 0; i < hvals.length; ++i) {
    const elem = JSON.parse(hvals[i]);
    if (!elem.isCloseCoAuthoring) {
      participantsMap.push(elem);
    }
  }
  return participantsMap;
});

function getOpenFormatByEditor(editorType) {
  let res;
  switch (editorType) {
    case EditorTypes.spreadsheet:
      res = constants.AVS_OFFICESTUDIO_FILE_CANVAS_SPREADSHEET;
      break;
    case EditorTypes.presentation:
      res = constants.AVS_OFFICESTUDIO_FILE_CANVAS_PRESENTATION;
      break;
    default:
      res = constants.AVS_OFFICESTUDIO_FILE_CANVAS_WORD;
      break;
  }
  return res;
}

exports.c_oAscServerStatus = c_oAscServerStatus;
exports.editorData = editorData;
exports.sendData = sendData;
exports.modifyConnectionForPassword = modifyConnectionForPassword;
exports.parseUrl = parseUrl;
exports.parseReplyData = parseReplyData;
exports.sendServerRequest = sendServerRequest;
exports.createSaveTimer = createSaveTimer;
exports.changeConnectionInfo = changeConnectionInfo;
exports.signToken = signToken;
exports.publish = publish;
exports.addTask = addTask;
exports.addDelayed = addDelayed;
exports.removeResponse = removeResponse;
exports.hasEditors = hasEditors;
exports.getEditorsCountPromise = co.wrap(getEditorsCount);
exports.getCallback = getCallback;
exports.getIsShutdown = getIsShutdown;
exports.hasChanges = hasChanges;
exports.cleanDocumentOnExitPromise = co.wrap(cleanDocumentOnExit);
exports.cleanDocumentOnExitNoChangesPromise = co.wrap(cleanDocumentOnExitNoChanges);
exports.unlockWopiDoc = unlockWopiDoc;
exports.setForceSave = setForceSave;
exports.startForceSave = startForceSave;
exports.resetForceSaveAfterChanges = resetForceSaveAfterChanges;
exports.getExternalChangeInfo = getExternalChangeInfo;
exports.checkJwt = checkJwt;
exports.getRequestParams = getRequestParams;
exports.checkJwtHeader = checkJwtHeader;
function encryptPasswordParams(ctx, data) {
  return co(function*(){
    let dataWithPassword;
    if (data.type === 'openDocument' && data.message) {
      dataWithPassword = data.message;
    } else if (data.type === 'auth' && data.openCmd) {
      dataWithPassword = data.openCmd;
    } else if (data.c === 'savefromorigin') {
      dataWithPassword = data;
    }
    if (dataWithPassword && dataWithPassword.password) {
      if (dataWithPassword.password.length > constants.PASSWORD_MAX_LENGTH) {
        ctx.logger.warn('encryptPasswordParams password too long actual = %s; max = %s', dataWithPassword.password.length, constants.PASSWORD_MAX_LENGTH);
        dataWithPassword.password = null;
      } else {
        dataWithPassword.password = yield utils.encryptPassword(ctx, dataWithPassword.password);
      }
    }
    if (dataWithPassword && dataWithPassword.savepassword) {
      if (dataWithPassword.savepassword.length > constants.PASSWORD_MAX_LENGTH) {
        ctx.logger.warn('encryptPasswordParams password too long actual = %s; max = %s', dataWithPassword.savepassword.length, constants.PASSWORD_MAX_LENGTH);
        dataWithPassword.savepassword = null;
      } else {
        dataWithPassword.savepassword = yield utils.encryptPassword(ctx, dataWithPassword.savepassword);
      }
    }
  });
}
exports.encryptPasswordParams = encryptPasswordParams;
exports.getOpenFormatByEditor = getOpenFormatByEditor;
exports.install = function(server, callbackFunction) {
  const io = new Server(server, cfgSocketIoConnection);

  io.use((socket, next) => {
    co(function*(){
      let ctx = new operationContext.Context();
      let res;
      let checkJwtRes;
      try {
        ctx.initFromConnection(socket);
        yield ctx.initTenantCache();
        ctx.logger.info('io.use start');
        const tenTokenEnableBrowser = ctx.getCfg('services.CoAuthoring.token.enable.browser', cfgTokenEnableBrowser);

        let handshake = socket.handshake;
        if (tenTokenEnableBrowser) {
          let secretType = !!(handshake?.auth?.session) ? commonDefines.c_oAscSecretType.Session : commonDefines.c_oAscSecretType.Browser;
          let token = handshake?.auth?.session || handshake?.auth?.token;
          checkJwtRes = yield checkJwt(ctx, token, secretType);
          if (!checkJwtRes.decoded) {
            res = new Error("not authorized");
            res.data = { code: checkJwtRes.code, description: checkJwtRes.description };
          }
        }
      } catch (err) {
        ctx.logger.error('io.use error: %s', err.stack);
      } finally {
        ctx.logger.info('io.use end');
        next(res);
      }
    });
  });

  io.on('connection', function(conn) {
    if (!conn) {
      operationContext.global.logger.error("null == conn");
      return;
    }
    let ctx = new operationContext.Context();
    ctx.initFromConnection(conn);
    if (getIsShutdown()) {
      sendFileError(ctx, conn, 'Server shutdow');
      return;
    }
    conn.baseUrl = utils.getBaseUrlByConnection(ctx, conn);
    conn.sessionIsSendWarning = false;
    conn.sessionTimeConnect = conn.sessionTimeLastAction = new Date().getTime();

    conn.on('message', function(data) {
      return co(function* () {
      var docId = 'null';
      let ctx = new operationContext.Context();
      try {
        ctx.initFromConnection(conn);
        yield ctx.initTenantCache();
        const tenErrorFiles = ctx.getCfg('FileConverter.converter.errorfiles', cfgErrorFiles);

        var startDate = null;
        if(clientStatsD) {
          startDate = new Date();
        }

        docId = conn.docId;
        ctx.logger.info('data.type = %s', data.type);
        if(getIsShutdown())
        {
          ctx.logger.debug('Server shutdown receive data');
          return;
        }
        if (conn.isCiriticalError && ('message' == data.type || 'getLock' == data.type || 'saveChanges' == data.type ||
            'isSaveLock' == data.type)) {
          ctx.logger.warn("conn.isCiriticalError send command: type = %s", data.type);
          sendDataDisconnectReason(ctx, conn, constants.ACCESS_DENIED_CODE, constants.ACCESS_DENIED_REASON);
          conn.disconnect(true);
          return;
        }
        if ((conn.isCloseCoAuthoring || (conn.user && conn.user.view)) &&
            ('getLock' == data.type || 'saveChanges' == data.type || 'isSaveLock' == data.type)) {
          ctx.logger.warn("conn.user.view||isCloseCoAuthoring access deny: type = %s", data.type);
          sendDataDisconnectReason(ctx, conn, constants.ACCESS_DENIED_CODE, constants.ACCESS_DENIED_REASON);
          conn.disconnect(true);
          return;
        }
        yield encryptPasswordParams(ctx, data);
        switch (data.type) {
          case 'auth'          :
            try {
              yield* auth(ctx, conn, data);
            } catch(err){
              ctx.logger.error('auth error: %s', err.stack);
              sendDataDisconnectReason(ctx, conn, constants.ACCESS_DENIED_CODE, constants.ACCESS_DENIED_REASON);
              conn.disconnect(true);
              return;
            }
            break;
          case 'message'        :
            yield* onMessage(ctx, conn, data);
            break;
          case 'cursor'        :
            yield* onCursor(ctx, conn, data);
            break;
          case 'getLock'        :
            yield* getLock(ctx, conn, data, false);
            break;
          case 'saveChanges'      :
            yield* saveChanges(ctx, conn, data);
            break;
          case 'isSaveLock'      :
            yield* isSaveLock(ctx, conn, data);
            break;
          case 'unSaveLock'      :
            yield* unSaveLock(ctx, conn, -1, -1, -1);
            break;	// The index is sent -1, because this is an emergency withdrawal without saving
          case 'getMessages'      :
            yield* getMessages(ctx, conn, data);
            break;
          case 'unLockDocument'    :
            yield* checkEndAuthLock(ctx, data.unlock, data.isSave, docId, conn.user.id, data.releaseLocks, data.deleteIndex, conn);
            break;
          case 'close':
            yield* closeDocument(ctx, conn);
            break;
          case 'versionHistory'          : {
            let cmd = new commonDefines.InputCommand(data.cmd);
            yield* versionHistory(ctx, conn, cmd);
            break;
          }
          case 'openDocument'      : {
            var cmd = new commonDefines.InputCommand(data.message);
            cmd.fillFromConnection(conn);
            yield canvasService.openDocument(ctx, conn, cmd);
            break;
          }
          case 'clientLog':
            let level = data.level?.toLowerCase();
            if("trace" === level || "debug" === level || "info" === level || "warn" === level || "error" === level ||  "fatal" === level) {
              ctx.logger[level]("clientLog: %s", data.msg);
            }
            if ("error" === level && tenErrorFiles && docId) {
              let destDir = 'browser/' + docId;
              yield storage.copyPath(ctx, docId, destDir, undefined, tenErrorFiles);
              yield* saveErrorChanges(ctx, docId, destDir);
            }
            break;
          case 'extendSession' :
            ctx.logger.debug("extendSession idletime: %d", data.idletime);
            conn.sessionIsSendWarning = false;
            conn.sessionTimeLastAction = new Date().getTime() - data.idletime;
            break;
          case 'forceSaveStart' :
            var forceSaveRes;
            if (conn.user) {
              forceSaveRes = yield startForceSave(ctx, docId, commonDefines.c_oAscForceSaveTypes.Button, undefined, undefined, conn.user.idOriginal, conn.user.id, undefined, conn.user.indexUser);
            } else {
              forceSaveRes = {code: commonDefines.c_oAscServerCommandErrors.UnknownError, time: null};
            }
            sendData(ctx, conn, {type: "forceSaveStart", messages: forceSaveRes});
            break;
          case 'rpc' :
            yield* startRPC(ctx, conn, data.responseKey, data.data);
            break;
          case 'authChangesAck' :
            delete conn.authChangesAck;
            break;
          default:
            ctx.logger.debug("unknown command %j", data);
            break;
        }
        if(clientStatsD) {
          if('openDocument' != data.type) {
            clientStatsD.timing('coauth.data.' + data.type, new Date() - startDate);
          }
        }
      } catch (e) {
        ctx.logger.error("error receiving response: type = %s %s", (data && data.type) ? data.type : 'null', e.stack);
      }
      });
    });
    conn.on("disconnect", function(reason) {
      return co(function* () {
        let ctx = new operationContext.Context();
        try {
          ctx.initFromConnection(conn);
          yield ctx.initTenantCache();
          yield* closeDocument(ctx, conn, reason);
        } catch (err) {
          ctx.logger.error('Error conn close: %s', err.stack);
        }
      });
    });

    _checkLicense(ctx, conn);
  });
  io.engine.on("connection_error", (err) => {
    operationContext.global.logger.warn('io.connection_error code=%s, message=%s', err.code, err.message);
  });
  function* closeDocument(ctx, conn, reason) {
    const tenTokenEnableBrowser = ctx.getCfg('services.CoAuthoring.token.enable.browser', cfgTokenEnableBrowser);
    const tenForgottenFiles = ctx.getCfg('services.CoAuthoring.server.forgottenfiles', cfgForgottenFiles);

    var userLocks, reconnected = false, bHasEditors, bHasChanges;
    var docId = conn.docId;
    if (null == docId) {
      return;
    }
    var hvals;
    let participantsTimestamp;
    var tmpUser = conn.user;
    var isView = tmpUser.view;
    ctx.logger.info("Connection closed or timed out: reason = %s", reason);
    var isCloseCoAuthoringTmp = conn.isCloseCoAuthoring;
    if (reason) {
      connections = _.reject(connections, function(el) {
        return el.id === conn.id;//Delete this connection
      });
      reconnected = yield* isUserReconnect(ctx, docId, tmpUser.id, conn.id);
      if (reconnected) {
        ctx.logger.info("reconnected");
      } else {
        yield removePresence(ctx, conn);
        hvals = yield editorData.getPresence(ctx, docId, connections);
        participantsTimestamp = Date.now();
        if (hvals.length <= 0) {
          yield editorData.removePresenceDocument(ctx, docId);
        }
      }
    } else {
      if (!conn.isCloseCoAuthoring) {
        tmpUser.view = true;
        conn.isCloseCoAuthoring = true;
        yield addPresence(ctx, conn, true);
        if (tenTokenEnableBrowser) {
          let sessionToken = yield fillJwtByConnection(ctx, conn);
          sendDataRefreshToken(ctx, conn, sessionToken);
        }
      }
    }

    if (isCloseCoAuthoringTmp) {
      return;
    }

    if (!reconnected) {
      var tmpView = tmpUser.view;
      tmpUser.view = isView;
      let participants = yield getParticipantMap(ctx, docId, hvals);
      if (!participantsTimestamp) {
        participantsTimestamp = Date.now();
      }
      yield* publish(ctx, {type: commonDefines.c_oPublishType.participantsState, ctx: ctx, docId: docId, userId: tmpUser.id, participantsTimestamp: participantsTimestamp, participants: participants}, docId, tmpUser.id);
      tmpUser.view = tmpView;
      yield editorData.unlockSave(ctx, docId, conn.user.id);
      if (false === isView) {
        bHasEditors = yield* hasEditors(ctx, docId, hvals);
        bHasChanges = yield hasChanges(ctx, docId);

        let needSendStatus = true;
        if (conn.encrypted) {
          let selectRes = yield taskResult.select(ctx, docId);
          if (selectRes.length > 0) {
            var row = selectRes[0];
            if (commonDefines.FileStatus.UpdateVersion === row.status) {
              needSendStatus = false;
            }
          }
        }
        userLocks = yield* removeUserLocks(ctx, docId, conn.user.id);
        if (0 < userLocks.length) {
          yield* publish(ctx, {type: commonDefines.c_oPublishType.releaseLock, ctx: ctx, docId: docId, userId: conn.user.id, locks: userLocks}, docId, conn.user.id);
        }
        yield* checkEndAuthLock(ctx, true, false, docId, conn.user.id);

        let userIndex = utils.getIndexFromUserId(tmpUser.id, tmpUser.idOriginal);
        if (!bHasEditors) {
          yield editorData.unlockSave(ctx, docId, tmpUser.id);

          let needSaveChanges = bHasChanges;
          if (!needSaveChanges) {
            let forgotten = yield storage.listObjects(ctx, docId, tenForgottenFiles);
            needSaveChanges = forgotten.length > 0;
            ctx.logger.debug('closeDocument hasForgotten %s', needSaveChanges);
          }
          if (needSaveChanges && !conn.encrypted) {
            yield createSaveTimer(ctx, docId, tmpUser.idOriginal, userIndex);
          } else if (needSendStatus) {
            yield* cleanDocumentOnExitNoChanges(ctx, docId, tmpUser.idOriginal, userIndex);
          } else {
            yield* cleanDocumentOnExit(ctx, docId, false, userIndex);
          }
        } else if (needSendStatus) {
          yield* sendStatusDocument(ctx, docId, c_oAscChangeBase.No, new commonDefines.OutputAction(commonDefines.c_oAscUserAction.Out, tmpUser.idOriginal), userIndex);
        }
      }
    }
  }

  function* versionHistory(ctx, conn, cmd) {
    const tenTokenEnableBrowser = ctx.getCfg('services.CoAuthoring.token.enable.browser', cfgTokenEnableBrowser);

    var docIdOld = conn.docId;
    var docIdNew = cmd.getDocId();
    if (tenTokenEnableBrowser) {
      var checkJwtRes = yield checkJwt(ctx, cmd.getTokenHistory(), commonDefines.c_oAscSecretType.Browser);
      if (checkJwtRes.decoded) {
        fillVersionHistoryFromJwt(checkJwtRes.decoded, cmd);
        docIdNew = cmd.getDocId();
        cmd.setWithAuthorization(true);
      } else {
        sendData(ctx, conn, {type: "expiredToken", code: checkJwtRes.code, description: checkJwtRes.description});
        return;
      }
    }
    if (docIdOld !== docIdNew) {
      yield removePresence(ctx, conn);
      var hvals = yield editorData.getPresence(ctx, docIdOld, connections);
      if (hvals.length <= 0) {
        yield editorData.removePresenceDocument(ctx, docIdOld);
      }
      conn.docId = docIdNew;
      yield addPresence(ctx, conn, true);
      if (tenTokenEnableBrowser) {
        let sessionToken = yield fillJwtByConnection(ctx, conn);
        sendDataRefreshToken(ctx, conn, sessionToken);
      }
    }
    yield canvasService.openDocument(ctx, conn, cmd, null);
  }
  function* getDocumentChanges(ctx, docId, optStartIndex, optEndIndex) {
    var arrayElements = yield sqlBase.getChangesPromise(ctx, docId, optStartIndex, optEndIndex);
    var j, element;
    var objChangesDocument = new DocumentChanges(docId);
    for (j = 0; j < arrayElements.length; ++j) {
      element = arrayElements[j];
      objChangesDocument.push({docid: docId, change: element['change_data'],
        time: element['change_date'].getTime(), user: element['user_id'],
        useridoriginal: element['user_id_original']});
    }
    return objChangesDocument;
  }

  function* getAllLocks(ctx, docId) {
    var docLockRes = [];
    var docLock = yield editorData.getLocks(ctx, docId);
    for (var i = 0; i < docLock.length; ++i) {
      docLockRes.push(docLock[i]);
    }
    return docLockRes;
  }
  function* removeUserLocks(ctx, docId, userId) {
    var userLocks = [], i;
    var toCache = [];
    var docLock = yield* getAllLocks(ctx, docId);
    for (i = 0; i < docLock.length; ++i) {
      var elem = docLock[i];
      if (elem.user === userId) {
        userLocks.push(elem);
      } else {
        toCache.push(elem);
      }
    }
    yield editorData.removeLocks(ctx, docId);
    yield editorData.addLocks(ctx, docId, toCache);
    return userLocks;
  }

	function* checkEndAuthLock(ctx, unlock, isSave, docId, userId, releaseLocks, deleteIndex, conn) {
		let result = false;

    if (null != deleteIndex && -1 !== deleteIndex) {
      let puckerIndex = yield* getChangesIndex(ctx, docId);
      const deleteCount = puckerIndex - deleteIndex;
      if (0 < deleteCount) {
        puckerIndex -= deleteCount;
        yield sqlBase.deleteChangesPromise(ctx, docId, deleteIndex);
      } else if (0 > deleteCount) {
        ctx.logger.error("Error checkEndAuthLock: deleteIndex: %s ; startIndex: %s ; deleteCount: %s",
                     deleteIndex, puckerIndex, deleteCount);
      }
    }

		if (unlock) {
			var unlockRes = yield editorData.unlockAuth(ctx, docId, userId);
			if (commonDefines.c_oAscUnlockRes.Unlocked === unlockRes) {
				const participantsMap = yield getParticipantMap(ctx, docId);
				yield* publish(ctx, {
					type: commonDefines.c_oPublishType.auth,
                    ctx: ctx,
					docId: docId,
					userId: userId,
					participantsMap: participantsMap
				});

				result = true;
			}
		}
		if (releaseLocks && conn) {
			const userLocks = yield* removeUserLocks(ctx, docId, userId);
			if (0 < userLocks.length) {
				sendReleaseLock(ctx, conn, userLocks);
				yield* publish(ctx, {
					type: commonDefines.c_oPublishType.releaseLock,
                    ctx: ctx,
					docId: docId,
					userId: userId,
					locks: userLocks
				}, docId, userId);
			}
		}
		if (isSave && conn) {
			yield* unSaveLock(ctx, conn, -1, -1, -1);
		}

		return result;
	}

  function* setLockDocumentTimer(ctx, docId, userId) {
    const tenExpLockDoc = ctx.getCfg('services.CoAuthoring.expire.lockDoc', cfgExpLockDoc);
    let timerId = setTimeout(function() {
      return co(function*() {
        try {
          ctx.logger.warn("lockDocumentsTimerId timeout");
          delete lockDocumentsTimerId[docId];
          yield* checkEndAuthLock(ctx, true, false, docId, userId);
          yield* publishCloseUsersConnection(ctx, docId, [userId], false, constants.DROP_CODE, constants.DROP_REASON);
        } catch (e) {
          ctx.logger.error("lockDocumentsTimerId error: %s", e.stack);
        }
      });
    }, 1000 * tenExpLockDoc);
    lockDocumentsTimerId[docId] = {timerId: timerId, userId: userId};
    ctx.logger.debug("lockDocumentsTimerId set");
  }
  function cleanLockDocumentTimer(docId, lockDocumentTimer) {
    clearTimeout(lockDocumentTimer.timerId);
    delete lockDocumentsTimerId[docId];
  }

  function sendParticipantsState(ctx, participants, data) {
    _.each(participants, function(participant) {
      sendData(ctx, participant, {
        type: "connectState",
        participantsTimestamp: data.participantsTimestamp,
        participants: data.participants,
        waitAuth: !!data.waitAuthUserId
      });
    });
  }

  function sendFileError(ctx, conn, errorId, code) {
    ctx.logger.warn('error description: errorId = %s', errorId);
    conn.isCiriticalError = true;
    sendData(ctx, conn, {type: 'error', description: errorId, code: code});
  }

  function* sendFileErrorAuth(ctx, conn, sessionId, errorId, code) {
    const tenTokenEnableBrowser = ctx.getCfg('services.CoAuthoring.token.enable.browser', cfgTokenEnableBrowser);

    conn.isCloseCoAuthoring = true;
    conn.sessionId = sessionId;//restore old
    connections = _.reject(connections, function(el) {
      return el.sessionId === sessionId;//Delete this connection
    });
    if (constants.CONN_CLOSED !== conn.conn.readyState) {
      connections.push(conn);
      yield addPresence(ctx, conn, true);
      if (tenTokenEnableBrowser) {
        let sessionToken = yield fillJwtByConnection(ctx, conn);
        sendDataRefreshToken(ctx, conn, sessionToken);
      }
      sendFileError(ctx, conn, errorId, code);
    }
  }
  function _recalcLockArray(userId, _locks, oRecalcIndexColumns, oRecalcIndexRows) {
    if (null == _locks) {
      return false;
    }
    var count = _locks.length;
    var element = null, oRangeOrObjectId = null;
    var i;
    var sheetId = -1;
    var isModify = false;
    for (i = 0; i < count; ++i) {
      if (userId === _locks[i].user) {
        continue;
      }
      element = _locks[i].block;
      if (c_oAscLockTypeElem.Range !== element["type"] ||
        c_oAscLockTypeElemSubType.InsertColumns === element["subType"] ||
        c_oAscLockTypeElemSubType.InsertRows === element["subType"]) {
        continue;
      }
      sheetId = element["sheetId"];

      oRangeOrObjectId = element["rangeOrObjectId"];

      if (oRecalcIndexColumns && oRecalcIndexColumns.hasOwnProperty(sheetId)) {
        oRangeOrObjectId["c1"] = oRecalcIndexColumns[sheetId].getLockMe2(oRangeOrObjectId["c1"]);
        oRangeOrObjectId["c2"] = oRecalcIndexColumns[sheetId].getLockMe2(oRangeOrObjectId["c2"]);
        isModify = true;
      }
      if (oRecalcIndexRows && oRecalcIndexRows.hasOwnProperty(sheetId)) {
        oRangeOrObjectId["r1"] = oRecalcIndexRows[sheetId].getLockMe2(oRangeOrObjectId["r1"]);
        oRangeOrObjectId["r2"] = oRecalcIndexRows[sheetId].getLockMe2(oRangeOrObjectId["r2"]);
        isModify = true;
      }
    }
    return isModify;
  }

  function _addRecalcIndex(oRecalcIndex) {
    if (null == oRecalcIndex) {
      return null;
    }
    var nIndex = 0;
    var nRecalcType = c_oAscRecalcIndexTypes.RecalcIndexAdd;
    var oRecalcIndexElement = null;
    var oRecalcIndexResult = {};

    for (var sheetId in oRecalcIndex) {
      if (oRecalcIndex.hasOwnProperty(sheetId)) {
        if (!oRecalcIndexResult.hasOwnProperty(sheetId)) {
          oRecalcIndexResult[sheetId] = new CRecalcIndex();
        }
        for (; nIndex < oRecalcIndex[sheetId]._arrElements.length; ++nIndex) {
          oRecalcIndexElement = oRecalcIndex[sheetId]._arrElements[nIndex];
          if (true === oRecalcIndexElement.m_bIsSaveIndex) {
            continue;
          }
          nRecalcType = (c_oAscRecalcIndexTypes.RecalcIndexAdd === oRecalcIndexElement._recalcType) ?
            c_oAscRecalcIndexTypes.RecalcIndexRemove : c_oAscRecalcIndexTypes.RecalcIndexAdd;
          oRecalcIndexResult[sheetId].add(nRecalcType, oRecalcIndexElement._position,
            oRecalcIndexElement._count, /*bIsSaveIndex*/true);
        }
      }
    }

    return oRecalcIndexResult;
  }

  function compareExcelBlock(newBlock, oldBlock) {
    if (null !== newBlock.subType && null !== oldBlock.subType) {
      return true;
    }
    if ((c_oAscLockTypeElemSubType.ChangeProperties === oldBlock.subType &&
      c_oAscLockTypeElem.Sheet !== newBlock.type) ||
      (c_oAscLockTypeElemSubType.ChangeProperties === newBlock.subType &&
        c_oAscLockTypeElem.Sheet !== oldBlock.type)) {
      return false;
    }

    var resultLock = false;
    if (newBlock.type === c_oAscLockTypeElem.Range) {
      if (oldBlock.type === c_oAscLockTypeElem.Range) {
        if (c_oAscLockTypeElemSubType.InsertRows === oldBlock.subType || c_oAscLockTypeElemSubType.InsertColumns === oldBlock.subType) {
          resultLock = false;
        } else if (isInterSection(newBlock.rangeOrObjectId, oldBlock.rangeOrObjectId)) {
          resultLock = true;
        }
      } else if (oldBlock.type === c_oAscLockTypeElem.Sheet) {
        resultLock = true;
      }
    } else if (newBlock.type === c_oAscLockTypeElem.Sheet) {
      resultLock = true;
    } else if (newBlock.type === c_oAscLockTypeElem.Object) {
      if (oldBlock.type === c_oAscLockTypeElem.Sheet) {
        resultLock = true;
      } else if (oldBlock.type === c_oAscLockTypeElem.Object && oldBlock.rangeOrObjectId === newBlock.rangeOrObjectId) {
        resultLock = true;
      }
    }
    return resultLock;
  }

  function isInterSection(range1, range2) {
    if (range2.c1 > range1.c2 || range2.c2 < range1.c1 || range2.r1 > range1.r2 || range2.r2 < range1.r1) {
      return false;
    }
    return true;
  }

  function comparePresentationBlock(newBlock, oldBlock) {
    var resultLock = false;

    switch (newBlock.type) {
      case c_oAscLockTypeElemPresentation.Presentation:
        if (c_oAscLockTypeElemPresentation.Presentation === oldBlock.type) {
          resultLock = newBlock.val === oldBlock.val;
        }
        break;
      case c_oAscLockTypeElemPresentation.Slide:
        if (c_oAscLockTypeElemPresentation.Slide === oldBlock.type) {
          resultLock = newBlock.val === oldBlock.val;
        }
        else if (c_oAscLockTypeElemPresentation.Object === oldBlock.type) {
          resultLock = newBlock.val === oldBlock.slideId;
        }
        break;
      case c_oAscLockTypeElemPresentation.Object:
        if (c_oAscLockTypeElemPresentation.Slide === oldBlock.type) {
          resultLock = newBlock.slideId === oldBlock.val;
        }
        else if (c_oAscLockTypeElemPresentation.Object === oldBlock.type) {
          resultLock = newBlock.objId === oldBlock.objId;
        }
        break;
    }
    return resultLock;
  }

  function* authRestore(ctx, conn, sessionId) {
    conn.sessionId = sessionId;//restore old
    connections = _.reject(connections, function(el) {
      return el.sessionId === sessionId;//Delete this connection
    });

    yield* endAuth(ctx, conn, true);
  }

  function fillUsername(ctx, data) {
    let name;
    let user = data.user;
    if (user.firstname && user.lastname) {
      let isRu = (data.lang && /^ru/.test(data.lang));
      name = isRu ? user.lastname + ' ' + user.firstname : user.firstname + ' ' + user.lastname;
    } else {
      name = user.username || "Anonymous";
    }
    if (name.length > constants.USER_NAME_MAX_LENGTH) {
      ctx.logger.warn('fillUsername user name too long actual = %s; max = %s', name.length, constants.USER_NAME_MAX_LENGTH);
      name = name.substr(0, constants.USER_NAME_MAX_LENGTH);
    }
    return name;
  }
  function isEditMode(permissions, mode) {
    return (!mode || mode !== 'view') && (!permissions || permissions.edit !== false || permissions.review === true ||
        permissions.comment === true || permissions.fillForms === true);
    }
  function fillDataFromWopiJwt(decoded, data) {
    let res = true;
    var openCmd = data.openCmd;

    if (decoded.key) {
      data.docid = decoded.key;
    }
    if (decoded.userAuth) {
      data.documentCallbackUrl = JSON.stringify(decoded.userAuth);
      data.mode = decoded.userAuth.mode;
    }
    if (decoded.queryParams) {
      let queryParams = decoded.queryParams;
      data.lang = queryParams.lang || queryParams.ui || "en-US";
    }
    if (decoded.fileInfo) {
      let fileInfo = decoded.fileInfo;
      if (openCmd) {
        let fileType = fileInfo.BaseFileName ? fileInfo.BaseFileName.substr(fileInfo.BaseFileName.lastIndexOf('.') + 1) : "";
        openCmd.format = fileInfo.FileExtension ? fileInfo.FileExtension.substr(1) : fileType;
        openCmd.title = fileInfo.BreadcrumbDocName || fileInfo.BaseFileName;
      }
      let name = fileInfo.IsAnonymousUser ? "" : fileInfo.UserFriendlyName;
      if (name) {
        data.user.username = name;
        data.denyChangeName = true;
      }
      if (null != fileInfo.UserId) {
        data.user.id = fileInfo.UserId;
        if (openCmd) {
          openCmd.userid = fileInfo.UserId;
        }
      }
      let permissions = {
        edit: !fileInfo.ReadOnly && fileInfo.UserCanWrite,
        review: (fileInfo.SupportsReviewing === false) ? false : (fileInfo.UserCanReview === false ? false : fileInfo.UserCanReview),
        copy: fileInfo.CopyPasteRestrictions !== "CurrentDocumentOnly" && fileInfo.CopyPasteRestrictions !== "BlockAll",
        print: !fileInfo.DisablePrint && !fileInfo.HidePrintOption
      };
      if (!data.permissions) {
        data.permissions = {};
      }
      Object.assign(data.permissions, permissions);
    }
    if (decoded.iss) {
      data.iss = decoded.iss;
    }
    return res;
  }
  function validateAuthToken(data, decoded) {
    var res = "";
    if (!decoded?.document?.key) {
      res = "document.key";
    } else if (data.permissions && !decoded?.document?.permissions) {
      res = "document.permissions";
    } else if (!decoded?.document?.url) {
      res = "document.url";
    } else if (data.documentCallbackUrl && !decoded?.editorConfig?.callbackUrl) {
      res = "editorConfig.callbackUrl";
    } else if (data.mode && !decoded?.editorConfig?.mode) {
      res = "editorConfig.mode";
    }
    return res;
  }
  function fillDataFromJwt(ctx, decoded, data) {
    let res = true;
    var openCmd = data.openCmd;
    if (decoded.document) {
      var doc = decoded.document;
      if(null != doc.key){
        data.docid = doc.key;
        if(openCmd){
          openCmd.id = doc.key;
        }
      }
      if(doc.permissions) {
        res = deepEqual(data.permissions, doc.permissions, {strict: true});
        if (!res) {
          ctx.logger.warn('fillDataFromJwt token has modified permissions');
        }
        if(!data.permissions){
          data.permissions = {};
        }
        Object.assign(data.permissions, doc.permissions);
      }
      if(openCmd){
        if(null != doc.fileType) {
          openCmd.format = doc.fileType;
        }
        if(null != doc.title) {
          openCmd.title = doc.title;
        }
        if(null != doc.url) {
          openCmd.url = doc.url;
        }
      }
      if (null != doc.ds_encrypted) {
        data.encrypted = doc.ds_encrypted;
      }
    }
    if (decoded.editorConfig) {
      var edit = decoded.editorConfig;
      if (null != edit.callbackUrl) {
        data.documentCallbackUrl = edit.callbackUrl;
      }
      if (null != edit.lang) {
        data.lang = edit.lang;
      }
      if (null != edit.mode) {
        data.mode = edit.mode;
      }
      if (edit.coEditing?.mode) {
        data.coEditingMode = edit.coEditing.mode;
        if (edit.coEditing?.change) {
          data.coEditingMode = 'fast';
        }
        let type = constants.VIEWER_ONLY.exec(decoded.document?.fileType);
        if ((type && typeof type[1] === 'string') || "embedded" === decoded.type) {
          data.coEditingMode = 'strict';
        }
      }
      if (null != edit.ds_view) {
        data.view = edit.ds_view;
      }
      if (null != edit.ds_isCloseCoAuthoring) {
        data.isCloseCoAuthoring = edit.ds_isCloseCoAuthoring;
      }
      data.isEnterCorrectPassword = edit.ds_isEnterCorrectPassword;
      data.denyChangeName = edit.ds_denyChangeName;
      data.sessionTimeConnect = edit.ds_sessionTimeConnect;
      if (edit.user) {
        var dataUser = data.user;
        var user = edit.user;
        if (user.id) {
          dataUser.id = user.id;
          if (openCmd) {
            openCmd.userid = user.id;
          }
        }
        if (null != user.index) {
          dataUser.indexUser = user.index;
        }
        if (user.firstname) {
          dataUser.firstname = user.firstname;
        }
        if (user.lastname) {
          dataUser.lastname = user.lastname;
        }
        if (user.name) {
          dataUser.username = user.name;
        }
        if (user.group) {
          dataUser.username = user.group.toString() + String.fromCharCode(160) + dataUser.username;
        }
      }
      if (edit.user && edit.user.name) {
        data.denyChangeName = true;
      }
    }
    if (decoded.url || decoded.payload|| (decoded.key && !decoded.fileInfo)) {
      ctx.logger.warn('fillDataFromJwt token has invalid format');
      res = false;
    }
    if (decoded.iss) {
      data.iss = decoded.iss;
    }
    return res;
  }
  function fillVersionHistoryFromJwt(decoded, cmd) {
    if (decoded.changesUrl && decoded.previous && (cmd.getServerVersion() === commonDefines.buildVersion)) {
      cmd.setUrl(decoded.previous.url);
      cmd.setDocId(decoded.previous.key);
    } else {
      cmd.setUrl(decoded.url);
      cmd.setDocId(decoded.key);
    }
  }

  function* auth(ctx, conn, data) {
    const tenExpUpdateVersionStatus = ms(ctx.getCfg('services.CoAuthoring.expire.updateVersionStatus', cfgExpUpdateVersionStatus));
    const tenTokenEnableBrowser = ctx.getCfg('services.CoAuthoring.token.enable.browser', cfgTokenEnableBrowser);
    const tenIsAnonymousSupport = ctx.getCfg('services.CoAuthoring.server.isAnonymousSupport', cfgIsAnonymousSupport);
    const tenTokenRequiredParams = ctx.getCfg('services.CoAuthoring.server.tokenRequiredParams', cfgTokenRequiredParams);
    ctx.logger.debug('auth time: %d', data.time);
    if (data.token && data.user) {
      ctx.setUserId(data.user.id);
      let licenseInfo = yield tenantManager.getTenantLicense(ctx);
      let isDecoded = false;
      if (tenTokenEnableBrowser) {
        let secretType = !!data.jwtSession ? commonDefines.c_oAscSecretType.Session : commonDefines.c_oAscSecretType.Browser;
        const checkJwtRes = yield checkJwt(ctx, data.jwtSession || data.jwtOpen, secretType);
        if (checkJwtRes.decoded) {
          isDecoded = true;
          let decoded = checkJwtRes.decoded;
          let fillDataFromJwtRes = false;
          if (decoded.fileInfo) {
            fillDataFromJwtRes = fillDataFromWopiJwt(decoded, data);
          } else if (decoded.editorConfig && undefined !== decoded.editorConfig.ds_view) {
            fillDataFromJwtRes = fillDataFromJwt(ctx, decoded, data);
          } else {
            let validationErr = validateAuthToken(data, decoded);
            if (!validationErr) {
              fillDataFromJwtRes = fillDataFromJwt(ctx, decoded, data);
            } else if (tenTokenRequiredParams) {
              ctx.logger.error("auth missing required parameter %s (since 7.1 version)", validationErr);
              sendDataDisconnectReason(ctx, conn, constants.JWT_ERROR_CODE, constants.JWT_ERROR_REASON);
              conn.disconnect(true);
              return;
            } else {
              ctx.logger.warn("auth missing required parameter %s (since 7.1 version)", validationErr);
              fillDataFromJwtRes = fillDataFromJwt(ctx, decoded, data);
            }
          }
          if(!fillDataFromJwtRes) {
            ctx.logger.warn("fillDataFromJwt return false");
            sendDataDisconnectReason(ctx, conn, constants.ACCESS_DENIED_CODE, constants.ACCESS_DENIED_REASON);
            conn.disconnect(true);
            return;
          }
        } else {
          sendDataDisconnectReason(ctx, conn, checkJwtRes.code, checkJwtRes.description);
          conn.disconnect(true);
          return;
        }
      }
      ctx.setUserId(data.user.id);

      let docId = data.docid;
      const user = data.user;

      let wopiParams = null;
      if (data.documentCallbackUrl) {
        wopiParams = wopiClient.parseWopiCallback(ctx, data.documentCallbackUrl);
        if (wopiParams && wopiParams.userAuth) {
          conn.access_token_ttl = wopiParams.userAuth.access_token_ttl;
        }
      }
      const bIsRestore = null != data.sessionId;
      let upsertRes = null;
      let curIndexUser, documentCallback;
      if (bIsRestore) {
        curIndexUser = user.indexUser;
      } else {
        if (data.documentCallbackUrl && !wopiParams) {
          documentCallback = url.parse(data.documentCallbackUrl);
          let filterStatus = yield* utils.checkHostFilter(ctx, documentCallback.hostname);
          if (0 !== filterStatus) {
            ctx.logger.warn('checkIpFilter error: url = %s', data.documentCallbackUrl);
            sendDataDisconnectReason(ctx, conn, constants.DROP_CODE, constants.DROP_REASON);
            conn.disconnect(true);
            return;
          }
        }
        let format = data.openCmd && data.openCmd.format;
        upsertRes = yield canvasService.commandOpenStartPromise(ctx, docId, utils.getBaseUrlByConnection(ctx, conn), true, data.documentCallbackUrl, format);
        let isInserted = upsertRes.affectedRows == 1;
        curIndexUser = isInserted ? 1 : upsertRes.insertId;
        if (isInserted && undefined !== data.timezoneOffset) {
          if (false === canvasService.hasAdditionalCol) {
            let selectRes = yield taskResult.select(ctx, docId);
            canvasService.hasAdditionalCol = selectRes.length > 0 && undefined !== selectRes[0].additional;
          }
          if (canvasService.hasAdditionalCol) {
            let task = new taskResult.TaskResultData();
            task.tenant = ctx.tenant;
            task.key = docId;
            task.additional = sqlBase.DocumentAdditional.prototype.setOpenedAt(Date.now(), data.timezoneOffset);
            yield taskResult.update(ctx, task);
          } else {
            ctx.logger.warn('auth unknown column "additional"');
          }
        }
      }
      if (constants.CONN_CLOSED === conn.conn.readyState) {
        return;
      }

      const curUserIdOriginal = String(user.id);
      const curUserId = curUserIdOriginal + curIndexUser;
      conn.tenant = tenantManager.getTenantByConnection(ctx, conn);
      conn.docId = data.docid;
      conn.permissions = data.permissions;
      conn.user = {
        id: curUserId,
        idOriginal: curUserIdOriginal,
        username: fillUsername(ctx, data),
        indexUser: curIndexUser,
        view: !isEditMode(data.permissions, data.mode)
      };
      if (conn.user.view && utils.isLiveViewerSupport(licenseInfo)) {
        conn.coEditingMode = data.coEditingMode;
      }
      conn.isCloseCoAuthoring = data.isCloseCoAuthoring;
      conn.isEnterCorrectPassword = data.isEnterCorrectPassword;
      conn.denyChangeName = data.denyChangeName;
      conn.editorType = data['editorType'];
      if (data.sessionTimeConnect) {
        conn.sessionTimeConnect = data.sessionTimeConnect;
      }
      if (data.sessionTimeIdle >= 0) {
        conn.sessionTimeLastAction = new Date().getTime() - data.sessionTimeIdle;
      }
      conn.unsyncTime = null;
      conn.encrypted = data.encrypted;
      conn.supportAuthChangesAck = data.supportAuthChangesAck;

      const c_LR = constants.LICENSE_RESULT;
      conn.licenseType = c_LR.Success;
      let isLiveViewer = utils.isLiveViewer(conn);
      if (!conn.user.view || isLiveViewer) {
        let logPrefixTenant = 'License of tenant: ';
        let logPrefixServer = 'License: ';
        let logPrefix = tenantManager.isMultitenantMode(ctx) ? logPrefixTenant : logPrefixServer;

        let licenseType = yield* _checkLicenseAuth(ctx, licenseInfo, conn.user.idOriginal, isLiveViewer, logPrefix);
        let aggregationCtx, licenseInfoAggregation;
        if ((c_LR.Success === licenseType || c_LR.SuccessLimit === licenseType) && tenantManager.isMultitenantMode(ctx) && !tenantManager.isDefaultTenant(ctx)) {
          aggregationCtx = new operationContext.Context();
          aggregationCtx.init(tenantManager.getDefautTenant(), ctx.docId, ctx.userId);
          licenseInfoAggregation = tenantManager.getServerLicense();
          licenseType = yield* _checkLicenseAuth(aggregationCtx, licenseInfoAggregation, `${ctx.tenant}:${ conn.user.idOriginal}`, isLiveViewer, logPrefixServer);
        }
        conn.licenseType = licenseType;
        if ((c_LR.Success !== licenseType && c_LR.SuccessLimit !== licenseType) || (!tenIsAnonymousSupport && data.IsAnonymousUser)) {
          if (!tenIsAnonymousSupport && data.IsAnonymousUser) {
            ctx.logger.error('auth: access to editor or live viewer is denied for anonymous users');
          }
          conn.user.view = true;
          delete conn.coEditingMode;
        } else {
          yield* updateEditUsers(ctx, licenseInfo, conn.user.idOriginal, !!data.IsAnonymousUser, isLiveViewer);
          if (aggregationCtx && licenseInfoAggregation) {
            yield* updateEditUsers(aggregationCtx, licenseInfoAggregation, `${ctx.tenant}:${ conn.user.idOriginal}`, !!data.IsAnonymousUser, isLiveViewer);
          }
        }
      }

      let cmd = null;
      if (data.openCmd) {
        cmd = new commonDefines.InputCommand(data.openCmd);
        cmd.fillFromConnection(conn);
        if (isDecoded) {
          cmd.setWithAuthorization(true);
        }
      }
      if (bIsRestore && data.isCloseCoAuthoring) {
        conn.sessionId = data.sessionId;//restore old
        connections = _.reject(connections, function(el) {
          return el.sessionId === data.sessionId;//Delete this connection
        });
        if (constants.CONN_CLOSED !== conn.conn.readyState) {
          connections.push(conn);
          yield addPresence(ctx, conn, true);
          yield* sendAuthInfo(ctx, conn, bIsRestore, undefined);
          if (cmd) {
            yield canvasService.openDocument(ctx, conn, cmd, upsertRes, bIsRestore);
          }
        }
        return;
      }
      let result = yield taskResult.select(ctx, docId);
      let resultRow = result.length > 0 ? result[0] : null;
      if (cmd && resultRow && resultRow.callback) {
        let userAuthStr = sqlBase.UserCallback.prototype.getCallbackByUserIndex(ctx, resultRow.callback, curIndexUser);
        let wopiParams = wopiClient.parseWopiCallback(ctx, userAuthStr, resultRow.callback);
        cmd.setWopiParams(wopiParams);
        if (wopiParams) {
          documentCallback = null;
          if (!wopiParams.userAuth || !wopiParams.commonInfo) {
            yield* sendFileErrorAuth(ctx, conn, data.sessionId, `invalid wopi callback (maybe postgres<9.5) ${JSON.stringify(wopiParams)}`);
            return;
          }
        }
      }
      if (conn.user.idOriginal.length > constants.USER_ID_MAX_LENGTH) {
        ctx.logger.warn('auth user id too long actual = %s; max = %s', curUserIdOriginal.length, constants.USER_ID_MAX_LENGTH);
        yield* sendFileErrorAuth(ctx, conn, data.sessionId, 'User id too long');
        return;
      }
      if (!conn.user.view) {
        var status = result && result.length > 0 ? result[0]['status'] : null;
        if (commonDefines.FileStatus.Ok === status) {
        } else if (commonDefines.FileStatus.SaveVersion === status ||
          (!bIsRestore && commonDefines.FileStatus.UpdateVersion === status &&
          Date.now() - result[0]['status_info'] * 60000 > tenExpUpdateVersionStatus)) {
          let newStatus = commonDefines.FileStatus.Ok;
          if (commonDefines.FileStatus.UpdateVersion === status) {
            ctx.logger.warn("UpdateVersion expired");
            newStatus = commonDefines.FileStatus.None;
          }
          var updateMask = new taskResult.TaskResultData();
          updateMask.tenant = ctx.tenant;
          updateMask.key = docId;
          updateMask.status = status;
          updateMask.statusInfo = result[0]['status_info'];
          var updateTask = new taskResult.TaskResultData();
          updateTask.status = newStatus;
          updateTask.statusInfo = constants.NO_ERROR;
          var updateIfRes = yield taskResult.updateIf(ctx, updateTask, updateMask);
          if (!(updateIfRes.affectedRows > 0)) {
            yield* sendFileErrorAuth(ctx, conn, data.sessionId, 'Update Version error', constants.UPDATE_VERSION_CODE);
            return;
          }
        } else if (bIsRestore && commonDefines.FileStatus.UpdateVersion === status) {
          yield* sendFileErrorAuth(ctx, conn, data.sessionId, 'Update Version error', constants.UPDATE_VERSION_CODE);
          return;
        } else if (commonDefines.FileStatus.None === status && conn.encrypted) {
        } else if (bIsRestore) {
          let code = null === status ? constants.NO_CACHE_CODE : undefined;
          yield* sendFileErrorAuth(ctx, conn, data.sessionId, 'Other error', code);
          return;
        }
      }
      if (bIsRestore) {
        ctx.logger.info("restored old session: id = %s", data.sessionId);

        if (!conn.user.view) {
          try {
            var puckerIndex = yield* getChangesIndex(ctx, docId);
            var bIsSuccessRestore = true;
            if (puckerIndex > 0) {
              let objChangesDocument = yield* getDocumentChanges(ctx, docId, puckerIndex - 1, puckerIndex);
              var change = objChangesDocument.arrChanges[objChangesDocument.getLength() - 1];
              if (change) {
                if (change['change']) {
                  if (change['user'] !== curUserId) {
                    bIsSuccessRestore = 0 === (((data['lastOtherSaveTime'] - change['time']) / 1000) >> 0);
                  }
                }
              } else {
                bIsSuccessRestore = false;
              }
            }

            if (bIsSuccessRestore) {
              var arrayBlocks = data['block'];
              var getLockRes = yield* getLock(ctx, conn, data, true);
              if (arrayBlocks && (0 === arrayBlocks.length || getLockRes)) {
                yield* authRestore(ctx, conn, data.sessionId);
              } else {
                yield* sendFileErrorAuth(ctx, conn, data.sessionId, 'Restore error. Locks not checked.', constants.RESTORE_CODE);
              }
            } else {
              yield* sendFileErrorAuth(ctx, conn, data.sessionId, 'Restore error. Document modified.', constants.RESTORE_CODE);
            }
          } catch (err) {
            ctx.logger.error("DataBase error: %s", err.stack);
            yield* sendFileErrorAuth(ctx, conn, data.sessionId, 'DataBase error', constants.RESTORE_CODE);
          }
        } else {
          yield* authRestore(ctx, conn, data.sessionId);
        }
      } else {
        conn.sessionId = conn.id;
        const endAuthRes = yield* endAuth(ctx, conn, false, documentCallback, canvasService.getOpenedAt(resultRow));
        if (endAuthRes && cmd) {
          yield canvasService.openDocument(ctx, conn, cmd, upsertRes, bIsRestore);
        }
      }
    }
  }

  function* endAuth(ctx, conn, bIsRestore, documentCallback, opt_openedAt) {
    const tenExpLockDoc = ctx.getCfg('services.CoAuthoring.expire.lockDoc', cfgExpLockDoc);
    const tenForgottenFiles = ctx.getCfg('services.CoAuthoring.server.forgottenfiles', cfgForgottenFiles);

    let res = true;
    const docId = conn.docId;
    const tmpUser = conn.user;
    let hasForgotten;
    if (constants.CONN_CLOSED === conn.conn.readyState) {
      return false;
    }
    connections.push(conn);
    let firstParticipantNoView, countNoView = 0;
    yield addPresence(ctx, conn, true);
    let participantsMap = yield getParticipantMap(ctx, docId);
    const participantsTimestamp = Date.now();
    for (let i = 0; i < participantsMap.length; ++i) {
      const elem = participantsMap[i];
      if (!elem.view) {
        ++countNoView;
        if (!firstParticipantNoView && elem.id !== tmpUser.id) {
          firstParticipantNoView = elem;
        }
      }
    }
    if (constants.CONN_CLOSED === conn.conn.readyState) {
      return false;
    }
    if (!tmpUser.view) {
      const userIndex = utils.getIndexFromUserId(tmpUser.id, tmpUser.idOriginal);
      const userAction = new commonDefines.OutputAction(commonDefines.c_oAscUserAction.In, tmpUser.idOriginal);
      let callback = yield* sendStatusDocument(ctx, docId, c_oAscChangeBase.No, userAction, userIndex, documentCallback, conn.baseUrl);
      if (!callback && !bIsRestore) {
        let forgotten = yield storage.listObjects(ctx, docId, tenForgottenFiles);
        hasForgotten = forgotten.length > 0;
        ctx.logger.debug('endAuth hasForgotten %s', hasForgotten);
      }
    }

    if (constants.CONN_CLOSED === conn.conn.readyState) {
      return false;
    }
    let lockDocument = null;
    let waitAuthUserId;
    if (!bIsRestore && 2 === countNoView && !tmpUser.view) {
      const lockRes = yield editorData.lockAuth(ctx, docId, firstParticipantNoView.id, 2 * tenExpLockDoc);
      if (constants.CONN_CLOSED === conn.conn.readyState) {
        return false;
      }
      if (lockRes) {
        lockDocument = firstParticipantNoView;
        waitAuthUserId = lockDocument.id;
        let lockDocumentTimer = lockDocumentsTimerId[docId];
        if (lockDocumentTimer) {
          cleanLockDocumentTimer(docId, lockDocumentTimer);
        }
        yield* setLockDocumentTimer(ctx, docId, lockDocument.id);
      }
    }
    if (constants.CONN_CLOSED === conn.conn.readyState) {
      return false;
    }
    if (lockDocument && !tmpUser.view) {
      const sendObject = {
        type: "waitAuth",
        lockDocument: lockDocument
      };
      sendData(ctx, conn, sendObject);//Or 0 if fails
    } else {
      if (!bIsRestore && needSendChanges(conn)) {
        yield* sendAuthChanges(ctx, conn.docId, [conn]);
      }
      if (constants.CONN_CLOSED === conn.conn.readyState) {
        return false;
      }
      yield* sendAuthInfo(ctx, conn, bIsRestore, participantsMap, hasForgotten, opt_openedAt);
    }
    if (constants.CONN_CLOSED === conn.conn.readyState) {
      return false;
    }
    yield* publish(ctx, {type: commonDefines.c_oPublishType.participantsState, ctx: ctx, docId: docId, userId: tmpUser.id, participantsTimestamp: participantsTimestamp, participants: participantsMap, waitAuthUserId: waitAuthUserId}, docId, tmpUser.id);
    return res;
  }

  function* saveErrorChanges(ctx, docId, destDir) {
    const tenEditor = getEditorConfig(ctx);
    const tenMaxRequestChanges = ctx.getCfg('services.CoAuthoring.server.maxRequestChanges', cfgMaxRequestChanges);
    const tenErrorFiles = ctx.getCfg('FileConverter.converter.errorfiles', cfgErrorFiles);

    let index = 0;
    let indexChunk = 1;
    let changes;
    let changesPrefix = destDir + '/' + constants.CHANGES_NAME + '/' + constants.CHANGES_NAME + '.json.';
    do {
      changes = yield sqlBase.getChangesPromise(ctx, docId, index, index + tenMaxRequestChanges);
      if (changes.length > 0) {
        let buffer;
        if (tenEditor['binaryChanges']) {
          let buffers = changes.map(elem => elem.change_data);
          buffers.unshift(Buffer.from(utils.getChangesFileHeader(), 'utf-8'))
          buffer = Buffer.concat(buffers);
        } else {
          let changesJSON = indexChunk > 1 ? ',[' : '[';
          changesJSON += changes[0].change_data;
          for (let i = 1; i < changes.length; ++i) {
            changesJSON += ',';
            changesJSON += changes[i].change_data;
          }
          changesJSON += ']\r\n';
          buffer = Buffer.from(changesJSON, 'utf8');
        }
        yield storage.putObject(ctx, changesPrefix + (indexChunk++).toString().padStart(3, '0'), buffer, buffer.length, tenErrorFiles);
      }
      index += tenMaxRequestChanges;
    } while (changes && tenMaxRequestChanges === changes.length);
  }

  function sendAuthChangesByChunks(ctx, changes, connections) {
    return co(function* () {
      const tenEditor = getEditorConfig(ctx);

      let startIndex = 0;
      let endIndex = 0;
      while (endIndex < changes.length) {
        startIndex = endIndex;
        let curBytes = 0;
        for (; endIndex < changes.length && curBytes < tenEditor['websocketMaxPayloadSize']; ++endIndex) {
          curBytes += JSON.stringify(changes[endIndex]).length + 24;//24 - for JSON overhead
        }
        const sendObject = {
          type: 'authChanges',
          changes: changes.slice(startIndex, endIndex)
        };
        for (let i = 0; i < connections.length; ++i) {
          let conn = connections[i];
          if (needSendChanges(conn)) {
            if (conn.supportAuthChangesAck) {
              conn.authChangesAck = true;
            }
            sendData(ctx, conn, sendObject);
          }
        }
        let time = 0;
        let interval = 100;
        let limit = 30000;
        for (let i = 0; i < connections.length; ++i) {
          let conn = connections[i];
          while (constants.CONN_CLOSED !== conn.readyState && needSendChanges(conn) && conn.authChangesAck && time < limit) {
            yield utils.sleep(interval);
            time += interval;
          }
          delete conn.authChangesAck;
        }
      }
    });
  }
  function* sendAuthChanges(ctx, docId, connections) {
    const tenMaxRequestChanges = ctx.getCfg('services.CoAuthoring.server.maxRequestChanges', cfgMaxRequestChanges);

    let index = 0;
    let changes;
    do {
      let objChangesDocument = yield getDocumentChanges(ctx, docId, index, index + tenMaxRequestChanges);
      changes = objChangesDocument.arrChanges;
      yield sendAuthChangesByChunks(ctx, changes, connections);
      connections = connections.filter((conn) => {
        return constants.CONN_CLOSED !== conn.readyState;
      });
      index += tenMaxRequestChanges;
    } while (connections.length > 0 && changes && tenMaxRequestChanges === changes.length);
  }
  function* sendAuthInfo(ctx, conn, bIsRestore, participantsMap, opt_hasForgotten, opt_openedAt) {
    const tenTokenEnableBrowser = ctx.getCfg('services.CoAuthoring.token.enable.browser', cfgTokenEnableBrowser);
    const tenImageSize = ctx.getCfg('services.CoAuthoring.server.limits_image_size', cfgImageSize);
    const tenTypesUpload = ctx.getCfg('services.CoAuthoring.utils.limits_image_types_upload', cfgTypesUpload);

    const docId = conn.docId;
    let docLock;
    if(EditorTypes.document == conn.editorType){
      docLock = {};
      let elem;
      const allLocks = yield* getAllLocks(ctx, docId);
      for(let i = 0 ; i < allLocks.length; ++i) {
        elem = allLocks[i];
        docLock[elem.block] = elem;
      }
    } else {
      docLock = yield* getAllLocks(ctx, docId);
    }
    let allMessages = yield editorData.getMessages(ctx, docId);
    allMessages = allMessages.length > 0 ? allMessages : undefined;//todo client side
    let sessionToken;
    if (tenTokenEnableBrowser && !bIsRestore) {
      sessionToken = yield fillJwtByConnection(ctx, conn);
    }
    let tenEditor = getEditorConfig(ctx);
    tenEditor["limits_image_size"] = tenImageSize;
    tenEditor["limits_image_types_upload"] = tenTypesUpload;
    const sendObject = {
      type: 'auth',
      result: 1,
      sessionId: conn.sessionId,
      sessionTimeConnect: conn.sessionTimeConnect,
      participants: participantsMap,
      messages: allMessages,
      locks: docLock,
      indexUser: conn.user.indexUser,
      hasForgotten: opt_hasForgotten,
      jwt: sessionToken,
      g_cAscSpellCheckUrl: tenEditor["spellcheckerUrl"],
      buildVersion: commonDefines.buildVersion,
      buildNumber: commonDefines.buildNumber,
      licenseType: conn.licenseType,
      settings: tenEditor,
      openedAt: opt_openedAt
    };
    sendData(ctx, conn, sendObject);//Or 0 if fails
  }

  function* onMessage(ctx, conn, data) {
    if (false === conn.permissions.chat) {
      ctx.logger.warn("insert message permissions.chat==false");
      return;
    }
    var docId = conn.docId;
    var userId = conn.user.id;
    var msg = {docid: docId, message: data.message, time: Date.now(), user: userId, useridoriginal: conn.user.idOriginal, username: conn.user.username};
    yield editorData.addMessage(ctx, docId, msg);
    ctx.logger.info("insert message: %j", msg);

    var messages = [msg];
    sendDataMessage(ctx, conn, messages);
    yield* publish(ctx, {type: commonDefines.c_oPublishType.message, ctx: ctx, docId: docId, userId: userId, messages: messages}, docId, userId);
  }

  function* onCursor(ctx, conn, data) {
    var docId = conn.docId;
    var userId = conn.user.id;
    var msg = {cursor: data.cursor, time: Date.now(), user: userId, useridoriginal: conn.user.idOriginal};

    ctx.logger.info("send cursor: %s", msg);

    var messages = [msg];
    yield* publish(ctx, {type: commonDefines.c_oPublishType.cursor, ctx: ctx, docId: docId, userId: userId, messages: messages}, docId, userId);
  }

  function* getLock(ctx, conn, data, bIsRestore) {
    ctx.logger.info("getLock");
    var fLock = null;
    switch (conn.editorType) {
      case EditorTypes.document:
        fLock = getLockWord;
        break;
      case EditorTypes.spreadsheet:
        fLock = getLockExcel;
        break;
      case EditorTypes.presentation:
        fLock = getLockPresentation;
        break;
    }
    return fLock ? yield* fLock(ctx, conn, data, bIsRestore) : false;
  }

  function* getLockWord(ctx, conn, data, bIsRestore) {
    var docId = conn.docId, userId = conn.user.id, arrayBlocks = data.block;
    var i;
    var checkRes = yield* _checkLock(ctx, docId, arrayBlocks);
    var documentLocks = checkRes.documentLocks;
    if (checkRes.res) {
      var toCache = [];
      for (i = 0; i < arrayBlocks.length; ++i) {
        var block = arrayBlocks[i];
        var elem = {time: Date.now(), user: userId, block: block};
        documentLocks[block] = elem;
        toCache.push(elem);
      }
      yield editorData.addLocks(ctx, docId, toCache);
    } else if (bIsRestore) {
      return false;
    }
    sendData(ctx, conn, {type: "getLock", locks: documentLocks});
    yield* publish(ctx, {type: commonDefines.c_oPublishType.getLock, ctx: ctx, docId: docId, userId: userId, documentLocks: documentLocks}, docId, userId);
    return true;
  }
  function* getLockExcel(ctx, conn, data, bIsRestore) {
    var docId = conn.docId, userId = conn.user.id, arrayBlocks = data.block;
    var i;
    var checkRes = yield* _checkLockExcel(ctx, docId, arrayBlocks, userId);
    var documentLocks = checkRes.documentLocks;
    if (checkRes.res) {
      var toCache = [];
      for (i = 0; i < arrayBlocks.length; ++i) {
        var block = arrayBlocks[i];
        var elem = {time: Date.now(), user: userId, block: block};
        documentLocks.push(elem);
        toCache.push(elem);
      }
      yield editorData.addLocks(ctx, docId, toCache);
    } else if (bIsRestore) {
      return false;
    }
    sendData(ctx, conn, {type: "getLock", locks: documentLocks});
    yield* publish(ctx, {type: commonDefines.c_oPublishType.getLock, ctx: ctx, docId: docId, userId: userId, documentLocks: documentLocks}, docId, userId);
    return true;
  }
  function* getLockPresentation(ctx, conn, data, bIsRestore) {
    var docId = conn.docId, userId = conn.user.id, arrayBlocks = data.block;
    var i;
    var checkRes = yield* _checkLockPresentation(ctx, docId, arrayBlocks, userId);
    var documentLocks = checkRes.documentLocks;
    if (checkRes.res) {
      var toCache = [];
      for (i = 0; i < arrayBlocks.length; ++i) {
        var block = arrayBlocks[i];
        var elem = {time: Date.now(), user: userId, block: block};
        documentLocks.push(elem);
        toCache.push(elem);
      }
      yield editorData.addLocks(ctx, docId, toCache);
    } else if (bIsRestore) {
      return false;
    }
    sendData(ctx, conn, {type: "getLock", locks: documentLocks});
    yield* publish(ctx, {type: commonDefines.c_oPublishType.getLock, ctx: ctx, docId: docId, userId: userId, documentLocks: documentLocks}, docId, userId);
    return true;
  }

  function sendGetLock(ctx, participants, documentLocks) {
    _.each(participants, function(participant) {
      sendData(ctx, participant, {type: "getLock", locks: documentLocks});
    });
  }
  function* saveChanges(ctx, conn, data) {
    const tenEditor = getEditorConfig(ctx);
    const tenPubSubMaxChanges = ctx.getCfg('services.CoAuthoring.pubsub.maxChanges', cfgPubSubMaxChanges);
    const tenExpSaveLock = ctx.getCfg('services.CoAuthoring.expire.saveLock', cfgExpSaveLock);

    const docId = conn.docId, userId = conn.user.id;
    ctx.logger.info("Start saveChanges: reSave: %s", data.reSave);

    let lockRes = yield editorData.lockSave(ctx, docId, userId, tenExpSaveLock);
    if (!lockRes) {
      ctx.logger.warn("saveChanges lockSave error");
      return;
    }

    let puckerIndex = yield* getChangesIndex(ctx, docId);

    if (constants.CONN_CLOSED === conn.conn.readyState) {
      return;
    }

    let deleteIndex = -1;
    if (data.startSaveChanges && null != data.deleteIndex) {
      deleteIndex = data.deleteIndex;
      if (-1 !== deleteIndex) {
        const deleteCount = puckerIndex - deleteIndex;
        if (0 < deleteCount) {
          puckerIndex -= deleteCount;
          yield sqlBase.deleteChangesPromise(ctx, docId, deleteIndex);
        } else if (0 > deleteCount) {
          ctx.logger.error("Error saveChanges: deleteIndex: %s ; startIndex: %s ; deleteCount: %s", deleteIndex, puckerIndex, deleteCount);
        }
      }
    }

    if (constants.CONN_CLOSED === conn.conn.readyState) {
      return;
    }
    const startIndex = puckerIndex;

    const newChanges = tenEditor['binaryChanges'] ? data.changes : JSON.parse(data.changes);
    let newChangesLastDate = new Date();
    newChangesLastDate.setMilliseconds(0);//remove milliseconds avoid issues with MySQL datetime rounding
    let newChangesLastTime = newChangesLastDate.getTime();
    let arrNewDocumentChanges = [];
    ctx.logger.info("saveChanges: deleteIndex: %s ; startIndex: %s ; length: %s", deleteIndex, startIndex, newChanges.length);
    if (0 < newChanges.length) {
      let oElement = null;

      for (let i = 0; i < newChanges.length; ++i) {
        oElement = newChanges[i];
        let change = tenEditor['binaryChanges'] ? oElement : JSON.stringify(oElement);
        arrNewDocumentChanges.push({docid: docId, change: change, time: newChangesLastDate,
          user: userId, useridoriginal: conn.user.idOriginal});
      }

      puckerIndex += arrNewDocumentChanges.length;
      yield sqlBase.insertChangesPromise(ctx, arrNewDocumentChanges, docId, startIndex, conn.user);
    }
    const changesIndex = (-1 === deleteIndex && data.startSaveChanges) ? startIndex : -1;
    if (data.endSaveChanges) {
      if (data.isExcel && false !== data.isCoAuthoring && data.excelAdditionalInfo) {
        const tmpAdditionalInfo = JSON.parse(data.excelAdditionalInfo);
        const oRecalcIndexColumns = _addRecalcIndex(tmpAdditionalInfo["indexCols"]);
        const oRecalcIndexRows = _addRecalcIndex(tmpAdditionalInfo["indexRows"]);
        if (null !== oRecalcIndexColumns || null !== oRecalcIndexRows) {
          const docLock = yield* getAllLocks(ctx, docId);
          if (_recalcLockArray(userId, docLock, oRecalcIndexColumns, oRecalcIndexRows)) {
            let toCache = [];
            for (let i = 0; i < docLock.length; ++i) {
              toCache.push(docLock[i]);
            }
            yield editorData.removeLocks(ctx, docId);
            yield editorData.addLocks(ctx, docId, toCache);
          }
        }
      }

      let userLocks = [];
      if (data.releaseLocks) {
		  userLocks = yield* removeUserLocks(ctx, docId, userId);
      }
      const checkEndAuthLockRes = yield* checkEndAuthLock(ctx, data.unlock, false, docId, userId);
      if (!checkEndAuthLockRes) {
        const arrLocks = _.map(userLocks, function(e) {
          return {
            block: e.block,
            user: e.user,
            time: Date.now(),
            changes: null
          };
        });
        let changesToSend = arrNewDocumentChanges;
        if(changesToSend.length > tenPubSubMaxChanges) {
          changesToSend = null;
        } else {
          changesToSend.forEach((value) => {
            value.time = value.time.getTime();
          })
        }
        yield* publish(ctx, {type: commonDefines.c_oPublishType.changes, ctx: ctx, docId: docId, userId: userId,
          changes: changesToSend, startIndex: startIndex, changesIndex: puckerIndex, syncChangesIndex: puckerIndex,
          locks: arrLocks, excelAdditionalInfo: data.excelAdditionalInfo, endSaveChanges: data.endSaveChanges}, docId, userId);
      }
      yield* unSaveLock(ctx, conn, changesIndex, newChangesLastTime, puckerIndex);
      let changeInfo = getExternalChangeInfo(conn.user, newChangesLastTime);
      yield resetForceSaveAfterChanges(ctx, docId, newChangesLastTime, puckerIndex, utils.getBaseUrlByConnection(ctx, conn), changeInfo);
    } else {
      let changesToSend = arrNewDocumentChanges;
      if(changesToSend.length > tenPubSubMaxChanges) {
        changesToSend = null;
      } else {
        changesToSend.forEach((value) => {
          value.time = value.time.getTime();
        })
      }
      let isPublished = yield* publish(ctx, {type: commonDefines.c_oPublishType.changes, ctx: ctx, docId: docId, userId: userId,
        changes: changesToSend, startIndex: startIndex, changesIndex: puckerIndex, syncChangesIndex: puckerIndex,
        locks: [], excelAdditionalInfo: undefined, endSaveChanges: data.endSaveChanges}, docId, userId);
      sendData(ctx, conn, {type: 'savePartChanges', changesIndex: changesIndex, syncChangesIndex: puckerIndex});
      if (!isPublished) {
        yield* publish(ctx, {type: commonDefines.c_oPublishType.changesNotify, ctx: ctx, docId: docId});
      }
    }
  }
  function* isSaveLock(ctx, conn, data) {
    const tenExpSaveLock = ctx.getCfg('services.CoAuthoring.expire.saveLock', cfgExpSaveLock);

    if (!conn.user) {
      return;
    }
    let lockRes = true;
    if (data.syncChangesIndex) {
      let forceSave = yield editorData.getForceSave(ctx, conn.docId);
      if (forceSave && forceSave.index !== data.syncChangesIndex) {
        if (!conn.unsyncTime) {
          conn.unsyncTime = new Date();
        }
        if (Date.now() - conn.unsyncTime.getTime() < tenExpSaveLock * 1000) {
          lockRes = false;
          ctx.logger.debug("isSaveLock editor unsynced since %j serverIndex:%s clientIndex:%s ", conn.unsyncTime, forceSave.index, data.syncChangesIndex);
          sendData(ctx, conn, {type: "saveLock", saveLock: !lockRes});
          return;
        } else {
          ctx.logger.warn("isSaveLock editor unsynced since %j serverIndex:%s clientIndex:%s ", conn.unsyncTime, forceSave.index, data.syncChangesIndex);
        }
      }
    }
    conn.unsyncTime = null;

    lockRes = yield editorData.lockSave(ctx, conn.docId, conn.user.id, tenExpSaveLock);
    ctx.logger.debug("isSaveLock lockRes: %s", lockRes);
    sendData(ctx, conn, {type: "saveLock", saveLock: !lockRes});
  }
  function* unSaveLock(ctx, conn, index, time, syncChangesIndex) {
    var unlockRes = yield editorData.unlockSave(ctx, conn.docId, conn.user.id);
    if (commonDefines.c_oAscUnlockRes.Locked !== unlockRes) {
      sendData(ctx, conn, {type: 'unSaveLock', index, time, syncChangesIndex});
    } else {
      ctx.logger.warn("unSaveLock failure");
    }
  }
  function* getMessages(ctx, conn) {
    let allMessages = yield editorData.getMessages(ctx, conn.docId);
    allMessages = allMessages.length > 0 ? allMessages : undefined;//todo client side
    sendDataMessage(ctx, conn, allMessages);
  }

  function* _checkLock(ctx, docId, arrayBlocks) {
    var isLock = false;
    var allLocks = yield* getAllLocks(ctx, docId);
    var documentLocks = {};
    for(var i = 0 ; i < allLocks.length; ++i) {
      var elem = allLocks[i];
      documentLocks[elem.block] =elem;
    }
    if (arrayBlocks.length > 0) {
      for (var i = 0; i < arrayBlocks.length; ++i) {
        var block = arrayBlocks[i];
        ctx.logger.info("getLock id: %s", block);
        if (documentLocks.hasOwnProperty(block) && documentLocks[block] !== null) {
          isLock = true;
          break;
        }
      }
    } else {
      isLock = true;
    }
    return {res: !isLock, documentLocks: documentLocks};
  }

  function* _checkLockExcel(ctx, docId, arrayBlocks, userId) {
    var documentLock;
    var isLock = false;
    var isExistInArray = false;
    var i, blockRange;
    var documentLocks = yield* getAllLocks(ctx, docId);
    var lengthArray = (arrayBlocks) ? arrayBlocks.length : 0;
    for (i = 0; i < lengthArray && false === isLock; ++i) {
      blockRange = arrayBlocks[i];
      for (var keyLockInArray in documentLocks) {
        if (true === isLock) {
          break;
        }
        if (!documentLocks.hasOwnProperty(keyLockInArray)) {
          continue;
        }
        documentLock = documentLocks[keyLockInArray];
        if (documentLock.user === userId &&
          blockRange.sheetId === documentLock.block.sheetId &&
          blockRange.type === c_oAscLockTypeElem.Object &&
          documentLock.block.type === c_oAscLockTypeElem.Object &&
          documentLock.block.rangeOrObjectId === blockRange.rangeOrObjectId) {
          isExistInArray = true;
          break;
        }

        if (c_oAscLockTypeElem.Sheet === blockRange.type &&
          c_oAscLockTypeElem.Sheet === documentLock.block.type) {
          if (documentLock.user === userId) {
            if (blockRange.sheetId === documentLock.block.sheetId) {
              isExistInArray = true;
              break;
            } else {
              continue;
            }
          } else {
            isLock = true;
            break;
          }
        }

        if (documentLock.user === userId || !(documentLock.block) ||
          blockRange.sheetId !== documentLock.block.sheetId) {
          continue;
        }
        isLock = compareExcelBlock(blockRange, documentLock.block);
      }
    }
    if (0 === lengthArray) {
      isLock = true;
    }
    return {res: !isLock && !isExistInArray, documentLocks: documentLocks};
  }

  function* _checkLockPresentation(ctx, docId, arrayBlocks, userId) {
    var isLock = false;
    var i, documentLock, blockRange;
    var documentLocks = yield* getAllLocks(ctx, docId);
    var lengthArray = (arrayBlocks) ? arrayBlocks.length : 0;
    for (i = 0; i < lengthArray && false === isLock; ++i) {
      blockRange = arrayBlocks[i];
      for (var keyLockInArray in documentLocks) {
        if (true === isLock) {
          break;
        }
        if (!documentLocks.hasOwnProperty(keyLockInArray)) {
          continue;
        }
        documentLock = documentLocks[keyLockInArray];

        if (documentLock.user === userId || !(documentLock.block)) {
          continue;
        }
        isLock = comparePresentationBlock(blockRange, documentLock.block);
      }
    }
    if (0 === lengthArray) {
      isLock = true;
    }
    return {res: !isLock, documentLocks: documentLocks};
  }

	function _checkLicense(ctx, conn) {
		return co(function* () {
			try {
				ctx.logger.info('_checkLicense start');
        const tenEditSingleton = ctx.getCfg('services.CoAuthoring.server.edit_singleton', cfgEditSingleton);
        const tenOpenProtectedFile = ctx.getCfg('services.CoAuthoring.server.openProtectedFile', cfgOpenProtectedFile);
        const tenIsAnonymousSupport = ctx.getCfg('services.CoAuthoring.server.isAnonymousSupport', cfgIsAnonymousSupport);

				let rights = constants.RIGHTS.Edit;
				if (tenEditSingleton) {
					let handshake = conn.handshake;
					const docIdParsed = constants.DOC_ID_SOCKET_PATTERN.exec(handshake.url);
					if (docIdParsed && 1 < docIdParsed.length) {
						const participantsMap = yield getParticipantMap(ctx, docIdParsed[1]);
						for (let i = 0; i < participantsMap.length; ++i) {
							const elem = participantsMap[i];
							if (!elem.view) {
								rights = constants.RIGHTS.View;
								break;
							}
						}
					}
				}

				let licenseInfo = yield tenantManager.getTenantLicense(ctx);

				sendData(ctx, conn, {
					type: 'license', license: {
						type: licenseInfo.type,
						light: licenseInfo.light,
						mode: licenseInfo.mode,
						rights: rights,
						buildVersion: commonDefines.buildVersion,
						buildNumber: commonDefines.buildNumber,
						protectionSupport: tenOpenProtectedFile, //todo find a better place
						isAnonymousSupport: tenIsAnonymousSupport, //todo find a better place
						liveViewerSupport: utils.isLiveViewerSupport(licenseInfo),
						branding: licenseInfo.branding,
						customization: licenseInfo.customization,
						advancedApi: licenseInfo.advancedApi,
						plugins: licenseInfo.plugins
					}
				});
				ctx.logger.info('_checkLicense end');
			} catch (err) {
				ctx.logger.error('_checkLicense error: %s', err.stack);
			}
		});
	}

  function* _checkLicenseAuth(ctx, licenseInfo, userId, isLiveViewer, logPrefix) {
    const tenWarningLimitPercents = ctx.getCfg('license.warning_limit_percents', cfgWarningLimitPercents) / 100;

    let licenseWarningLimitUsers = false;
    let licenseWarningLimitUsersView = false;
    let licenseWarningLimitConnections = false;
    let licenseWarningLimitConnectionsLive = false;
    const c_LR = constants.LICENSE_RESULT;
    let licenseType = licenseInfo.type;
    if (c_LR.Success === licenseType || c_LR.SuccessLimit === licenseType) {
      if (licenseInfo.usersCount) {
        const nowUTC = getLicenseNowUtc();
        if(isLiveViewer) {
          const arrUsers = yield editorData.getPresenceUniqueViewUser(ctx, nowUTC);
          if (arrUsers.length >= licenseInfo.usersViewCount && (-1 === arrUsers.findIndex((element) => {return element.userid === userId}))) {
            licenseType = c_LR.UsersViewCount;
          }
          licenseWarningLimitUsersView = licenseInfo.usersViewCount * tenWarningLimitPercents <= arrUsers.length;
        } else {
          const arrUsers = yield editorData.getPresenceUniqueUser(ctx, nowUTC);
          if (arrUsers.length >= licenseInfo.usersCount && (-1 === arrUsers.findIndex((element) => {return element.userid === userId}))) {
            licenseType = c_LR.UsersCount;
          }
          licenseWarningLimitUsers = licenseInfo.usersCount * tenWarningLimitPercents <= arrUsers.length;
        }
      } else if(isLiveViewer) {
        const connectionsLiveCount = licenseInfo.connectionsView;
        const liveViewerConnectionsCount = yield editorData.getLiveViewerConnectionsCount(ctx, connections);
        if (liveViewerConnectionsCount >= connectionsLiveCount) {
          licenseType = c_LR.ConnectionsLive;
        }
        licenseWarningLimitConnectionsLive = connectionsLiveCount * tenWarningLimitPercents <= liveViewerConnectionsCount;
      } else {
        const connectionsCount = licenseInfo.connections;
        const editConnectionsCount = yield editorData.getEditorConnectionsCount(ctx, connections);
        if (editConnectionsCount >= connectionsCount) {
          licenseType = c_LR.Connections;
        }
        licenseWarningLimitConnections = connectionsCount * tenWarningLimitPercents <= editConnectionsCount;
      }
    }

    if (c_LR.UsersCount === licenseType) {
      if (!licenseInfo.hasLicense) {
        licenseType = c_LR.UsersCountOS;
      }
      ctx.logger.error(logPrefix + 'User limit exceeded!!!');
    } else if (c_LR.UsersViewCount === licenseType) {
        if (!licenseInfo.hasLicense) {
          licenseType = c_LR.UsersViewCountOS;
        }
        ctx.logger.error(logPrefix + 'User Live Viewer limit exceeded!!!');
    } else if (c_LR.Connections === licenseType) {
      if (!licenseInfo.hasLicense) {
        licenseType = c_LR.ConnectionsOS;
      }
      ctx.logger.error(logPrefix + 'Connection limit exceeded!!!');
    } else if (c_LR.ConnectionsLive === licenseType) {
      if (!licenseInfo.hasLicense) {
        licenseType = c_LR.ConnectionsLiveOS;
      }
      ctx.logger.error(logPrefix + 'Connection Live Viewer limit exceeded!!!');
    } else {
      if (licenseWarningLimitUsers) {
        ctx.logger.warn(logPrefix + 'Warning User limit exceeded!!!');
      }
      if (licenseWarningLimitUsersView) {
        ctx.logger.warn(logPrefix + 'Warning User Live Viewer limit exceeded!!!');
      }
      if (licenseWarningLimitConnections) {
        ctx.logger.warn(logPrefix + 'Warning Connection limit exceeded!!!');
      }
      if (licenseWarningLimitConnectionsLive) {
        ctx.logger.warn(logPrefix + 'Warning Connection Live Viewer limit exceeded!!!');
      }
    }
    return licenseType;
  }
  pubsubOnMessage = function(msg) {
    return co(function* () {
      let ctx = new operationContext.Context();
      try {
        var data = JSON.parse(msg);
        ctx.initFromPubSub(data);
        yield ctx.initTenantCache();
        ctx.logger.debug('pubsub message start:%s', msg);
        const tenTokenEnableBrowser = ctx.getCfg('services.CoAuthoring.token.enable.browser', cfgTokenEnableBrowser);

        var participants;
        var participant;
        var objChangesDocument;
        var i;
        let lockDocumentTimer, cmd;
        switch (data.type) {
          case commonDefines.c_oPublishType.drop:
            for (i = 0; i < data.users.length; ++i) {
              dropUserFromDocument(ctx, data.docId, data.users[i], data.description);
            }
            break;
          case commonDefines.c_oPublishType.closeConnection:
            closeUsersConnection(ctx, data.docId, data.usersMap, data.isOriginalId, data.code, data.description);
            break;
          case commonDefines.c_oPublishType.releaseLock:
            participants = getParticipants(data.docId, true, data.userId, true);
            _.each(participants, function(participant) {
              sendReleaseLock(ctx, participant, data.locks);
            });
            break;
          case commonDefines.c_oPublishType.participantsState:
            participants = getParticipants(data.docId, true, data.userId);
            sendParticipantsState(ctx, participants, data);
            break;
          case commonDefines.c_oPublishType.message:
            participants = getParticipants(data.docId, true, data.userId);
            _.each(participants, function(participant) {
              sendDataMessage(ctx, participant, data.messages);
            });
            break;
          case commonDefines.c_oPublishType.getLock:
            participants = getParticipants(data.docId, true, data.userId, true);
            sendGetLock(ctx, participants, data.documentLocks);
            break;
          case commonDefines.c_oPublishType.changes:
            lockDocumentTimer = lockDocumentsTimerId[data.docId];
            if (lockDocumentTimer) {
              ctx.logger.debug("lockDocumentsTimerId update c_oPublishType.changes");
              cleanLockDocumentTimer(data.docId, lockDocumentTimer);
              yield* setLockDocumentTimer(ctx, data.docId, lockDocumentTimer.userId);
            }
            participants = getParticipants(data.docId, true, data.userId);
            if(participants.length > 0) {
              var changes = data.changes;
              if (null == changes) {
                objChangesDocument = yield* getDocumentChanges(ctx, data.docId, data.startIndex, data.changesIndex);
                changes = objChangesDocument.arrChanges;
              }
              _.each(participants, function(participant) {
                if (!needSendChanges(participant)) {
                  return;
                }
                sendData(ctx, participant, {type: 'saveChanges', changes: changes,
                  changesIndex: data.changesIndex, syncChangesIndex: data.syncChangesIndex, endSaveChanges:  data.endSaveChanges,
                  locks: data.locks, excelAdditionalInfo: data.excelAdditionalInfo});
              });
            }
            break;
          case commonDefines.c_oPublishType.changesNotify:
            lockDocumentTimer = lockDocumentsTimerId[data.docId];
            if (lockDocumentTimer) {
              ctx.logger.debug("lockDocumentsTimerId update c_oPublishType.changesNotify");
              cleanLockDocumentTimer(data.docId, lockDocumentTimer);
              yield* setLockDocumentTimer(ctx, data.docId, lockDocumentTimer.userId);
            }
            break;
          case commonDefines.c_oPublishType.auth:
            lockDocumentTimer = lockDocumentsTimerId[data.docId];
            if (lockDocumentTimer) {
              ctx.logger.debug("lockDocumentsTimerId clear");
              cleanLockDocumentTimer(data.docId, lockDocumentTimer);
            }
            participants = getParticipants(data.docId, true, data.userId, true);
            if(participants.length > 0) {
              yield* sendAuthChanges(ctx, data.docId, participants);
              for (i = 0; i < participants.length; ++i) {
                participant = participants[i];
                yield* sendAuthInfo(ctx, participant, false, data.participantsMap);
              }
            }
            break;
          case commonDefines.c_oPublishType.receiveTask:
            cmd = new commonDefines.InputCommand(data.cmd, true);
            var output = new canvasService.OutputDataWrap();
            output.fromObject(data.output);
            var outputData = output.getData();

            var docConnectionId = cmd.getDocConnectionId();
            var docId;
            if(docConnectionId){
              docId = docConnectionId;
            } else {
              docId = cmd.getDocId();
            }
            if (cmd.getUserConnectionId()) {
              participants = getParticipantUser(docId, cmd.getUserConnectionId());
            } else {
              participants = getParticipants(docId);
            }
            for (i = 0; i < participants.length; ++i) {
              participant = participants[i];
              if (data.needUrlKey) {
                if (0 == data.needUrlMethod) {
                  outputData.setData(yield storage.getSignedUrls(ctx, participant.baseUrl, data.needUrlKey, data.needUrlType, data.creationDate));
                } else if (1 == data.needUrlMethod) {
                  outputData.setData(yield storage.getSignedUrl(ctx, participant.baseUrl, data.needUrlKey, data.needUrlType, undefined, data.creationDate));
                } else {
                  let url;
                  if (cmd.getInline()) {
                    url = yield canvasService.getPrintFileUrl(ctx, data.needUrlKey, participant.baseUrl, cmd.getTitle());
                    outputData.setExtName('.pdf');
                  } else {
                    url = yield storage.getSignedUrl(ctx, participant.baseUrl, data.needUrlKey, data.needUrlType, cmd.getTitle(), data.creationDate);
                    outputData.setExtName(pathModule.extname(data.needUrlKey));
                  }
                  outputData.setData(url);
                }
                if (undefined !== data.openedAt) {
                  outputData.setOpenedAt(data.openedAt);
                }
                yield modifyConnectionForPassword(ctx, participant, data.needUrlIsCorrectPassword);
              }
              sendData(ctx, participant, output);
            }
            break;
          case commonDefines.c_oPublishType.warning:
            participants = getParticipants(data.docId);
            _.each(participants, function(participant) {
              sendDataWarning(ctx, participant, data.description);
            });
            break;
          case commonDefines.c_oPublishType.cursor:
            participants = getParticipants(data.docId, true, data.userId);
            _.each(participants, function(participant) {
              sendDataCursor(ctx, participant, data.messages);
            });
            break;
          case commonDefines.c_oPublishType.shutdown:
            shutdownFlag = data.status;
            ctx.logger.warn('start shutdown:%b', shutdownFlag);
            if (shutdownFlag) {
              ctx.logger.warn('active connections: %d', connections.length);
              var connectionsTmp = connections.slice();
              for (i = 0; i < connectionsTmp.length; ++i) {
                sendDataDisconnectReason(ctx, connectionsTmp[i], constants.SHUTDOWN_CODE, constants.SHUTDOWN_REASON);
                connectionsTmp[i].disconnect(true);
              }
            }
            ctx.logger.warn('end shutdown');
            break;
          case commonDefines.c_oPublishType.meta:
            participants = getParticipants(data.docId);
            _.each(participants, function(participant) {
              sendDataMeta(ctx, participant, data.meta);
            });
            break;
          case commonDefines.c_oPublishType.forceSave:
            participants = getParticipants(data.docId, true, data.userId, true);
            _.each(participants, function(participant) {
              sendData(ctx, participant, {type: "forceSave", messages: data.data});
            });
            break;
          case commonDefines.c_oPublishType.changeConnecitonInfo:
            let hasChanges = false;
            cmd = new commonDefines.InputCommand(data.cmd, true);
            participants = getParticipants(data.docId);
            for (i = 0; i < participants.length; ++i) {
              participant = participants[i];
              if (!participant.denyChangeName && participant.user.idOriginal === data.useridoriginal) {
                hasChanges = true;
                ctx.logger.debug('changeConnectionInfo: userId = %s', data.useridoriginal);
                participant.user.username = cmd.getUserName();
                yield addPresence(ctx, participant, false);
                if (tenTokenEnableBrowser) {
                  let sessionToken = yield fillJwtByConnection(ctx, participant);
                  sendDataRefreshToken(ctx, participant, sessionToken);
                }
              }
            }
            if (hasChanges) {
              let participants = yield getParticipantMap(ctx, data.docId);
              let participantsTimestamp = Date.now();
              yield* publish(ctx, {type: commonDefines.c_oPublishType.participantsState, ctx: ctx, docId: data.docId, userId: null, participantsTimestamp: participantsTimestamp, participants: participants});
            }
            break;
          case commonDefines.c_oPublishType.rpc:
            participants = getParticipantUser(data.docId, data.userId);
            _.each(participants, function(participant) {
                sendDataRpc(ctx, participant, data.responseKey, data.data);
            });
            break;
          default:
            ctx.logger.debug('pubsub unknown message type:%s', msg);
        }
      } catch (err) {
        ctx.logger.error('pubsub message error: %s', err.stack);
      }
    });
  }

  function* collectStats(ctx, countEdit, countLiveView, countView) {
    let now = Date.now();
    yield editorData.setEditorConnections(ctx, countEdit, countLiveView, countView, now, PRECISION);
  }
  function expireDoc() {
    return co(function* () {
      let ctx = new operationContext.Context();
      try {
        let tenants = {};
        let countEditByShard = 0;
        let countLiveViewByShard = 0;
        let countViewByShard = 0;
        ctx.logger.debug('expireDoc connections.length = %d', connections.length);
        var nowMs = new Date().getTime();
        for (var i = 0; i < connections.length; ++i) {
          var conn = connections[i];
          ctx.initFromConnection(conn);
          yield ctx.initTenantCache();
          const tenExpSessionIdle = ms(ctx.getCfg('services.CoAuthoring.expire.sessionidle', cfgExpSessionIdle));
          const tenExpSessionAbsolute = ms(ctx.getCfg('services.CoAuthoring.expire.sessionabsolute', cfgExpSessionAbsolute));
          const tenExpSessionCloseCommand = ms(ctx.getCfg('services.CoAuthoring.expire.sessionclosecommand', cfgExpSessionCloseCommand));

          let maxMs = nowMs + Math.max(tenExpSessionCloseCommand, expDocumentsStep);
          let tenant = tenants[ctx.tenant];
          if (!tenant) {
            tenant = tenants[ctx.tenant] = {countEditByShard: 0, countLiveViewByShard: 0, countViewByShard: 0};
          }
          if (tenExpSessionAbsolute > 0 || conn.access_token_ttl) {
            if ((tenExpSessionAbsolute > 0 && maxMs - conn.sessionTimeConnect > tenExpSessionAbsolute ||
              (conn.access_token_ttl && maxMs > conn.access_token_ttl)) && !conn.sessionIsSendWarning) {
              conn.sessionIsSendWarning = true;
              sendDataSession(ctx, conn, {
                code: constants.SESSION_ABSOLUTE_CODE,
                reason: constants.SESSION_ABSOLUTE_REASON
              });
            } else if (nowMs - conn.sessionTimeConnect > tenExpSessionAbsolute) {
              ctx.logger.debug('expireDoc close absolute session');
              sendDataDisconnectReason(ctx, conn, constants.SESSION_ABSOLUTE_CODE, constants.SESSION_ABSOLUTE_REASON);
              conn.disconnect(true);
              continue;
            }
          }
          if (tenExpSessionIdle > 0 && !(conn.user?.view || conn.isCloseCoAuthoring)) {
            if (maxMs - conn.sessionTimeLastAction > tenExpSessionIdle && !conn.sessionIsSendWarning) {
              conn.sessionIsSendWarning = true;
              sendDataSession(ctx, conn, {
                code: constants.SESSION_IDLE_CODE,
                reason: constants.SESSION_IDLE_REASON,
                interval: tenExpSessionIdle
              });
            } else if (nowMs - conn.sessionTimeLastAction > tenExpSessionIdle) {
              ctx.logger.debug('expireDoc close idle session');
              sendDataDisconnectReason(ctx, conn, constants.SESSION_IDLE_CODE, constants.SESSION_IDLE_REASON);
              conn.disconnect(true);
              continue;
            }
          }
          if (constants.CONN_CLOSED === conn.conn.readyState) {
            ctx.logger.error('expireDoc connection closed');
          }
          yield addPresence(ctx, conn, false);
          if (utils.isLiveViewer(conn)) {
            countLiveViewByShard++;
            tenant.countLiveViewByShard++;
          } else if(conn.isCloseCoAuthoring || (conn.user && conn.user.view)) {
            countViewByShard++;
            tenant.countViewByShard++;
          } else {
            countEditByShard++;
            tenant.countEditByShard++;
          }
        }
        for (let tenantId in tenants) {
          if(tenants.hasOwnProperty(tenantId)) {
            ctx.setTenant(tenantId);
            let tenant = tenants[tenantId];
            yield* collectStats(ctx, tenant.countEditByShard, tenant.countLiveViewByShard, tenant.countViewByShard);
            yield editorData.setEditorConnectionsCountByShard(ctx, SHARD_ID, tenant.countEditByShard);
            yield editorData.setLiveViewerConnectionsCountByShard(ctx, SHARD_ID, tenant.countLiveViewByShard);
            yield editorData.setViewerConnectionsCountByShard(ctx, SHARD_ID, tenant.countViewByShard);
            if (clientStatsD) {
              let countEdit = yield editorData.getEditorConnectionsCount(ctx, connections);
              clientStatsD.gauge('expireDoc.connections.edit', countEdit);
              let countLiveView = yield editorData.getLiveViewerConnectionsCount(ctx, connections);
              clientStatsD.gauge('expireDoc.connections.liveview', countLiveView);
              let countView = yield editorData.getViewerConnectionsCount(ctx, connections);
              clientStatsD.gauge('expireDoc.connections.view', countView);
            }
          }
        }
        if (tenantManager.isMultitenantMode(ctx) && !tenantManager.isDefaultTenant(ctx)) {
          let aggregationCtx = new operationContext.Context();
          aggregationCtx.init(tenantManager.getDefautTenant(), ctx.docId, ctx.userId);
          yield editorData.setEditorConnectionsCountByShard(aggregationCtx, SHARD_ID, countEditByShard);
          yield editorData.setLiveViewerConnectionsCountByShard(aggregationCtx, SHARD_ID, countLiveViewByShard);
          yield editorData.setViewerConnectionsCountByShard(aggregationCtx, SHARD_ID, countViewByShard);
        }
        ctx.initDefault();
      } catch (err) {
        ctx.logger.error('expireDoc error: %s', err.stack);
      } finally {
        setTimeout(expireDoc, expDocumentsStep);
      }
    });
  }
  setTimeout(expireDoc, expDocumentsStep);
  function refreshWopiLock() {
    return co(function* () {
      let ctx = new operationContext.Context();
      try {
        ctx.logger.info('refreshWopiLock start');
        let docIds = new Map();
        for (let i = 0; i < connections.length; ++i) {
          let conn = connections[i];
          ctx.initFromConnection(conn);
          yield ctx.initTenantCache();
          let docId = conn.docId;
          if ((conn.user && conn.user.view) || docIds.has(docId)) {
            continue;
          }
          docIds.set(docId, 1);
          if (undefined === conn.access_token_ttl) {
            continue;
          }
          let selectRes = yield taskResult.select(ctx, docId);
          if (selectRes.length > 0 && selectRes[0] && selectRes[0].callback) {
            let callback = selectRes[0].callback;
            let callbackUrl = sqlBase.UserCallback.prototype.getCallbackByUserIndex(ctx, callback);
            let wopiParams = wopiClient.parseWopiCallback(ctx, callbackUrl, callback);
            if (wopiParams && wopiParams.commonInfo) {
              yield wopiClient.lock(ctx, 'REFRESH_LOCK', wopiParams.commonInfo.lockId,
                                    wopiParams.commonInfo.fileInfo, wopiParams.userAuth);
            }
          }
        }
        ctx.initDefault();
        ctx.logger.info('refreshWopiLock end');
      } catch (err) {
        ctx.logger.error('refreshWopiLock error:%s', err.stack);
      } finally {
        setTimeout(refreshWopiLock, cfgRefreshLockInterval);
      }
    });
  }
  setTimeout(refreshWopiLock, cfgRefreshLockInterval);

  pubsub = new pubsubService();
  pubsub.on('message', pubsubOnMessage);
  pubsub.init(function(err) {
    if (null != err) {
      operationContext.global.logger.error('createPubSub error: %s', err.stack);
    }

    queue = new queueService();
    queue.on('dead', handleDeadLetter);
    queue.on('response', canvasService.receiveTask);
    queue.init(true, true, false, true, true, true, function(err){
      if (null != err) {
        operationContext.global.logger.error('createTaskQueue error: %s', err.stack);
      }
      gc.startGC();

      let tableName = cfgTableResult;
      const tableRequiredColumn = 'tenant';
      sqlBase.getTableColumns(operationContext.global, tableName).then(function(res) {
        let index = res.findIndex((currentValue) => {
          for (let key in currentValue) {
            if (currentValue.hasOwnProperty(key) && 'column_name' === key.toLowerCase()) {
              return tableRequiredColumn === currentValue[key];
            }
          }
        });
        if (-1 !== index || 0 === res.length) {
          return editorData.connect().then(function() {
            callbackFunction();
          }).catch(err => {
            operationContext.global.logger.error('editorData error: %s', err.stack);
          });
        } else {
          operationContext.global.logger.error('DB table "%s" does not contain %s column, columns info: %j', tableName, tableRequiredColumn, res);
        }
      }).catch(err => {
        operationContext.global.logger.error('getTableColumns error: %s', err.stack);
      });
    });
  });
};
exports.setLicenseInfo = function(data, original ) {
  tenantManager.setDefLicense(data, original);
};
exports.healthCheck = function(req, res) {
  return co(function*() {
    let output = false;
    let ctx = new operationContext.Context();
    try {
      ctx.initFromRequest(req);
      yield ctx.initTenantCache();
      ctx.logger.info('healthCheck start');
      yield sqlBase.healthCheck(ctx);
      ctx.logger.debug('healthCheck database');
      if (editorData.isConnected()) {
        yield editorData.ping();
        ctx.logger.debug('healthCheck editorData');
      } else {
        throw new Error('redis disconnected');
      }

      const healthPubsub = yield pubsub.healthCheck();
      if (healthPubsub) {
        ctx.logger.debug('healthCheck pubsub');
      } else {
        throw new Error('pubsub');
      }
      const healthQueue = yield queue.healthCheck();
      if (healthQueue) {
        ctx.logger.debug('healthCheck queue');
      } else {
        throw new Error('queue');
      }
      const clusterId = cluster.isWorker ? cluster.worker.id : '';
      const tempName = 'hc_' + os.hostname() + '_' + clusterId + '_' + Math.round(Math.random() * HEALTH_CHECK_KEY_MAX);
      const tempBuffer = Buffer.from([1, 2, 3, 4, 5]);
      yield storage.putObject(ctx, tempName, tempBuffer, tempBuffer.length);
      try {
        yield storage.deleteObject(ctx, tempName);
      } catch (err) {
        ctx.logger.warn('healthCheck error %s', err.stack);
      }
      ctx.logger.debug('healthCheck storage');

      output = true;
      ctx.logger.info('healthCheck end');
    } catch (err) {
      ctx.logger.error('healthCheck error %s', err.stack);
    } finally {
      res.setHeader('Content-Type', 'text/plain');
      res.send(output.toString());
    }
  });
};
exports.licenseInfo = function(req, res) {
  return co(function*() {
    let isError = false;
    let serverDate = new Date();
    serverDate.setMilliseconds(0);
    let output = {
      connectionsStat: {}, licenseInfo: {}, serverInfo: {
        buildVersion: commonDefines.buildVersion, buildNumber: commonDefines.buildNumber, date: serverDate.toISOString()
      }, quota: {
        edit: {
          connectionsCount: 0,
          usersCount: {
            unique: 0,
            anonymous: 0,
          }
        },
        view: {
          connectionsCount: 0,
          usersCount: {
            unique: 0,
            anonymous: 0,
          }
        },
        byMonth: []
      }
    };

    let ctx = new operationContext.Context();
    try {
      ctx.initFromRequest(req);
      yield ctx.initTenantCache();
      ctx.logger.debug('licenseInfo start');

      let licenseInfo = yield tenantManager.getTenantLicense(ctx);
      Object.assign(output.licenseInfo, licenseInfo);

      var precisionSum = {};
      for (let i = 0; i < PRECISION.length; ++i) {
        precisionSum[PRECISION[i].name] = {
          edit: {min: Number.MAX_VALUE, sum: 0, count: 0, intervalsInPresision: PRECISION[i].val / expDocumentsStep, max: 0},
          liveview: {min: Number.MAX_VALUE, sum: 0, count: 0, intervalsInPresision: PRECISION[i].val / expDocumentsStep, max: 0},
          view: {min: Number.MAX_VALUE, sum: 0, count: 0, intervalsInPresision: PRECISION[i].val / expDocumentsStep, max: 0}
        };
        output.connectionsStat[PRECISION[i].name] = {
          edit: {min: 0, avr: 0, max: 0},
          liveview: {min: 0, avr: 0, max: 0},
          view: {min: 0, avr: 0, max: 0}
        };
      }
      var redisRes = yield editorData.getEditorConnections(ctx);
      const now = Date.now();
      if (redisRes.length > 0) {
        let expDocumentsStep95 = expDocumentsStep * 0.95;
        let prevTime = Number.MAX_VALUE;
        var precisionIndex = 0;
        for (let i = redisRes.length - 1; i >= 0; i--) {
          let elem = redisRes[i];
          let edit = elem.edit || 0;
          let view = elem.view || 0;
          let liveview = elem.liveview || 0;
          while (i > 0 && elem.time - redisRes[i - 1].time < expDocumentsStep95) {
            edit += elem.edit || 0;
            view += elem.view || 0;
            liveview += elem.liveview || 0;
            i--;
          }
          for (let j = precisionIndex; j < PRECISION.length; ++j) {
            if (now - elem.time < PRECISION[j].val) {
              let precision = precisionSum[PRECISION[j].name];
              precision.edit.min = Math.min(precision.edit.min, edit);
              precision.edit.max = Math.max(precision.edit.max, edit);
              precision.edit.sum += edit
              precision.edit.count++;
              precision.view.min = Math.min(precision.view.min, view);
              precision.view.max = Math.max(precision.view.max, view);
              precision.view.sum += view;
              precision.view.count++;
              precision.liveview.min = Math.min(precision.liveview.min, liveview);
              precision.liveview.max = Math.max(precision.liveview.max, liveview);
              precision.liveview.sum += liveview;
              precision.liveview.count++;
            } else {
              precisionIndex = j + 1;
            }
          }
          prevTime = elem.time;
        }
        for (let i in precisionSum) {
          let precision = precisionSum[i];
          let precisionOut = output.connectionsStat[i];
          if (precision.edit.count > 0) {
            precisionOut.edit.avr = Math.round(precision.edit.sum / precision.edit.intervalsInPresision);
            precisionOut.edit.min = precision.edit.min;
            precisionOut.edit.max = precision.edit.max;
          }
          if (precision.liveview.count > 0) {
            precisionOut.liveview.avr = Math.round(precision.liveview.sum / precision.liveview.intervalsInPresision);
            precisionOut.liveview.min = precision.liveview.min;
            precisionOut.liveview.max = precision.liveview.max;
          }
          if (precision.view.count > 0) {
            precisionOut.view.avr = Math.round(precision.view.sum / precision.view.intervalsInPresision);
            precisionOut.view.min = precision.view.min;
            precisionOut.view.max = precision.view.max;
          }
        }
      }
      const nowUTC = getLicenseNowUtc();
      let execRes;
      execRes = yield editorData.getPresenceUniqueUser(ctx, nowUTC);
      output.quota.edit.connectionsCount = yield editorData.getEditorConnectionsCount(ctx, connections);
      output.quota.edit.usersCount.unique = execRes.length;
      execRes.forEach(function(elem) {
        if (elem.anonym) {
          output.quota.edit.usersCount.anonymous++;
        }
      });

      execRes = yield editorData.getPresenceUniqueViewUser(ctx, nowUTC);
      output.quota.view.connectionsCount = yield editorData.getLiveViewerConnectionsCount(ctx, connections);
      output.quota.view.usersCount.unique = execRes.length;
      execRes.forEach(function(elem) {
        if (elem.anonym) {
          output.quota.view.usersCount.anonymous++;
        }
      });

      let byMonth = yield editorData.getPresenceUniqueUsersOfMonth(ctx);
      let byMonthView = yield editorData.getPresenceUniqueViewUsersOfMonth(ctx);
      let byMonthMerged = [];
      for (let i in byMonth) {
        if (byMonth.hasOwnProperty(i)) {
          byMonthMerged[i] = {date: i, users: byMonth[i], usersView: {}};
        }
      }
      for (let i in byMonthView) {
        if (byMonthView.hasOwnProperty(i)) {
          if (byMonthMerged.hasOwnProperty(i)) {
            byMonthMerged[i].usersView = byMonthView[i];
          } else {
            byMonthMerged[i] = {date: i, users: {}, usersView: byMonthView[i]};
          }
        }
      }
      output.quota.byMonth = Object.values(byMonthMerged);
      output.quota.byMonth.sort((a, b) => {
        return a.date.localeCompare(b.date);
      });

      ctx.logger.debug('licenseInfo end');
    } catch (err) {
      isError = true;
      ctx.logger.error('licenseInfo error %s', err.stack);
    } finally {
      if (!isError) {
        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify(output));
      } else {
        res.sendStatus(400);
      }
    }
  });
};
function validateInputParams(ctx, authRes, command) {
  const commandsWithoutKey = ['version', 'license', 'getForgottenList'];
  const isValidWithoutKey = commandsWithoutKey.includes(command.c);
  const isDocIdString = typeof command.key === 'string';

  ctx.setDocId(command.key);

  if(authRes.code === constants.VKEY_KEY_EXPIRE){
    return commonDefines.c_oAscServerCommandErrors.TokenExpire;
  } else if(authRes.code !== constants.NO_ERROR){
    return commonDefines.c_oAscServerCommandErrors.Token;
  }

  if (isValidWithoutKey || isDocIdString) {
    return commonDefines.c_oAscServerCommandErrors.NoError;
  } else {
    return commonDefines.c_oAscServerCommandErrors.DocumentIdError;
  }
}

function* getFilesKeys(ctx, opt_specialDir) {
  const directoryList = yield storage.listObjects(ctx, '', opt_specialDir);
  const keys = directoryList.map(directory => directory.split('/')[0]);

  const filteredKeys = [];
  let previousKey = null;
  for (const key of keys) {
    if (previousKey !== key) {
      previousKey = key;
      filteredKeys.push(key);
    }
  }

  return filteredKeys;
}

function* findForgottenFile(ctx, docId) {
  const tenForgottenFiles = ctx.getCfg('services.CoAuthoring.server.forgottenfiles', cfgForgottenFiles);
  const tenForgottenFilesName = ctx.getCfg('services.CoAuthoring.server.forgottenfilesname', cfgForgottenFilesName);

  const forgottenList = yield storage.listObjects(ctx, docId, tenForgottenFiles);
  return forgottenList.find(forgotten => tenForgottenFilesName === pathModule.basename(forgotten, pathModule.extname(forgotten)));
}

function* commandLicense(ctx) {
  const nowUTC = getLicenseNowUtc();
  const users = yield editorData.getPresenceUniqueUser(ctx, nowUTC);
  const users_view = yield editorData.getPresenceUniqueViewUser(ctx, nowUTC);
  const licenseInfo = yield tenantManager.getTenantLicense(ctx);

  return {
    license: utils.convertLicenseInfoToFileParams(licenseInfo),
    server: utils.convertLicenseInfoToServerParams(licenseInfo),
    quota: { users, users_view }
  };
}
function* commandHandle(ctx, params, req, output) {
  const tenForgottenFiles = ctx.getCfg('services.CoAuthoring.server.forgottenfiles', cfgForgottenFiles);

  const docId = params.key;
  const forgottenData = {};

  switch (params.c) {
    case 'info': {
      const selectRes = yield taskResult.select(ctx, docId);
      if (selectRes.length > 0) {
        output.error = yield* bindEvents(ctx, docId, params.callback, utils.getBaseUrlByRequest(ctx, req), undefined, params.userdata);
      } else {
        output.error = commonDefines.c_oAscServerCommandErrors.DocumentIdError;
      }
      break;
    }
    case 'drop': {
      if (params.userid) {
        yield* publish(ctx, {type: commonDefines.c_oPublishType.drop, ctx: ctx, docId: docId, users: [params.userid], description: params.description});
      } else if (params.users) {
        const users = (typeof params.users === 'string') ? JSON.parse(params.users) : params.users;
        yield* dropUsersFromDocument(ctx, docId, users);
      } else {
        output.error = commonDefines.c_oAscServerCommandErrors.UnknownCommand;
      }
      break;
    }
    case 'saved': {
      if ('1' !== params.status) {
        yield editorData.setSaved(ctx, docId, params.status);
        ctx.logger.warn('saved corrupted id = %s status = %s conv = %s', docId, params.status, params.conv);
      } else {
        ctx.logger.info('saved id = %s status = %s conv = %s', docId, params.status, params.conv);
      }
      break;
    }
    case 'forcesave': {
      let forceSaveRes = yield startForceSave(ctx, docId, commonDefines.c_oAscForceSaveTypes.Command, params.userdata, undefined, undefined, undefined, undefined, undefined, undefined, utils.getBaseUrlByRequest(ctx, req));
      output.error = forceSaveRes.code;
      break;
    }
    case 'meta': {
      if (params.meta) {
        yield* publish(ctx, {type: commonDefines.c_oPublishType.meta, ctx: ctx, docId: docId, meta: params.meta});
      } else {
        output.error = commonDefines.c_oAscServerCommandErrors.UnknownCommand;
      }
      break;
    }
    case 'getForgotten': {
      const forgottenFileFullPath = yield* findForgottenFile(ctx, docId);
      if (!forgottenFileFullPath) {
        output.error = commonDefines.c_oAscServerCommandErrors.DocumentIdError;
        break;
      }

      const forgottenFile = pathModule.basename(forgottenFileFullPath);
      const baseUrl = utils.getBaseUrlByRequest(ctx, req);
      forgottenData.url = yield storage.getSignedUrl(
        ctx, baseUrl, forgottenFileFullPath, commonDefines.c_oAscUrlTypes.Temporary, forgottenFile, undefined, tenForgottenFiles
      );
      break;
    }
    case 'deleteForgotten': {
      const forgottenFile = yield* findForgottenFile(ctx, docId);
      if (!forgottenFile) {
        output.error = commonDefines.c_oAscServerCommandErrors.DocumentIdError;
        break;
      }

      yield storage.deleteObject(ctx, forgottenFile, tenForgottenFiles);
      break;
    }
    case 'getForgottenList': {
      forgottenData.keys = yield* getFilesKeys(ctx, tenForgottenFiles);
      break;
    }
    case 'version': {
      output.version = `${commonDefines.buildVersion}.${commonDefines.buildNumber}`;
      break;
    }
    case 'license': {
      const outputLicense = yield* commandLicense(ctx);
      Object.assign(output, outputLicense);
      break;
    }
    default: {
      output.error = commonDefines.c_oAscServerCommandErrors.UnknownCommand;
      break;
    }
  }

  Object.assign(output, forgottenData);
}
exports.commandFromServer = function (req, res) {
  return co(function* () {
    const output = { key: 'commandFromServer', error: commonDefines.c_oAscServerCommandErrors.NoError, version: undefined };
    const ctx = new operationContext.Context();
    try {
      ctx.initFromRequest(req);
      yield ctx.initTenantCache();
      ctx.logger.info('commandFromServer start');
      const authRes = yield getRequestParams(ctx, req);
      const params = authRes.params;
      output.key = params.key;
      output.error = validateInputParams(ctx, authRes, params);
      if (output.error === commonDefines.c_oAscServerCommandErrors.NoError) {
        ctx.logger.debug('commandFromServer: c = %s', params.c);
        yield *commandHandle(ctx, params, req, output);
      }
    } catch (err) {
      output.error = commonDefines.c_oAscServerCommandErrors.UnknownError;
      ctx.logger.error('Error commandFromServer: %s', err.stack);
    } finally {
      const outputBuffer = Buffer.from(JSON.stringify(output), 'utf8');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Length', outputBuffer.length);
      res.send(outputBuffer);
      ctx.logger.info('commandFromServer end : %j', output);
    }
  });
};

exports.shutdown = function(req, res) {
  return co(function*() {
    let output = false;
    let ctx = new operationContext.Context();
    try {
      ctx.initFromRequest(req);
      yield ctx.initTenantCache();
      ctx.logger.info('shutdown start');
      output = yield shutdown.shutdown(ctx, editorData, req.method === 'PUT');
    } catch (err) {
      ctx.logger.error('shutdown error %s', err.stack);
    } finally {
      res.setHeader('Content-Type', 'text/plain');
      res.send(output.toString());
      ctx.logger.info('shutdown end');
    }
  });
};
