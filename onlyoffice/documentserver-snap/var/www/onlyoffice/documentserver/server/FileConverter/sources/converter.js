/*
 * Copyright (C) undefined 2012-2023. All rights reserved
 *
 * undefined 
 *
 * Version: 7.5.1 (build:0)
 */


'use strict';
var os = require('os');
var path = require('path');
var fs = require('fs');
var url = require('url');
var co = require('co');
var config = require('config');
var spawnAsync = require('@expo/spawn-async');
const bytes = require('bytes');
const lcid = require('lcid');

var commonDefines = require('./../../Common/sources/commondefines');
var storage = require('./../../Common/sources/storage-base');
var utils = require('./../../Common/sources/utils');
var constants = require('./../../Common/sources/constants');
var baseConnector = require('./../../DocService/sources/baseConnector');
const wopiClient = require('./../../DocService/sources/wopiClient');
const taskResult = require('./../../DocService/sources/taskresult');
var statsDClient = require('./../../Common/sources/statsdclient');
var queueService = require('./../../Common/sources/taskqueueRabbitMQ');
const formatChecker = require('./../../Common/sources/formatchecker');
const operationContext = require('./../../Common/sources/operationContext');
const tenantManager = require('./../../Common/sources/tenantManager');

const cfgMaxDownloadBytes = config.get('FileConverter.converter.maxDownloadBytes');
const cfgDownloadTimeout = config.get('FileConverter.converter.downloadTimeout');
const cfgDownloadAttemptMaxCount = config.get('FileConverter.converter.downloadAttemptMaxCount');
const cfgDownloadAttemptDelay = config.get('FileConverter.converter.downloadAttemptDelay');
const cfgFontDir = config.get('FileConverter.converter.fontDir');
const cfgPresentationThemesDir = config.get('FileConverter.converter.presentationThemesDir');
const cfgX2tPath = config.get('FileConverter.converter.x2tPath');
const cfgDocbuilderPath = config.get('FileConverter.converter.docbuilderPath');
const cfgArgs = config.get('FileConverter.converter.args');
const cfgSpawnOptions = config.get('FileConverter.converter.spawnOptions');
const cfgErrorFiles = config.get('FileConverter.converter.errorfiles');
const cfgInputLimits = config.get('FileConverter.converter.inputLimits');
const cfgStreamWriterBufferSize = config.get('FileConverter.converter.streamWriterBufferSize');
const cfgMaxRequestChanges = config.get('services.CoAuthoring.server.maxRequestChanges');
const cfgForgottenFiles = config.get('services.CoAuthoring.server.forgottenfiles');
const cfgForgottenFilesName = config.get('services.CoAuthoring.server.forgottenfilesname');
const cfgNewFileTemplate = config.get('services.CoAuthoring.server.newFileTemplate');
const cfgEditor = config.get('services.CoAuthoring.editor');
const cfgAllowPrivateIPAddressForSignedRequests = config.get('services.CoAuthoring.server.allowPrivateIPAddressForSignedRequests');
const cfgRequesFilteringAgent = config.get('services.CoAuthoring.request-filtering-agent');
var MAX_OPEN_FILES = 200;
var TEMP_PREFIX = 'ASC_CONVERT';
var queue = null;
var clientStatsD = statsDClient.getClient();
var exitCodesReturn = [constants.CONVERT_PARAMS, constants.CONVERT_NEED_PARAMS, constants.CONVERT_CORRUPTED,
  constants.CONVERT_DRM, constants.CONVERT_DRM_UNSUPPORTED, constants.CONVERT_PASSWORD, constants.CONVERT_LIMITS,
  constants.CONVERT_DETECT];
var exitCodesMinorError = [constants.CONVERT_NEED_PARAMS, constants.CONVERT_DRM, constants.CONVERT_DRM_UNSUPPORTED, constants.CONVERT_PASSWORD];
var exitCodesUpload = [constants.NO_ERROR, constants.CONVERT_CORRUPTED, constants.CONVERT_NEED_PARAMS,
  constants.CONVERT_DRM, constants.CONVERT_DRM_UNSUPPORTED];
let inputLimitsXmlCache;

function TaskQueueDataConvert(ctx, task) {
  var cmd = task.getCmd();
  this.key = cmd.savekey ? cmd.savekey : cmd.id;
  this.fileFrom = null;
  this.fileTo = null;
  this.title = cmd.getTitle();
  if(constants.AVS_OFFICESTUDIO_FILE_CROSSPLATFORM_PDFA !== cmd.getOutputFormat()){
    this.formatTo = cmd.getOutputFormat();
  } else {
    this.formatTo = constants.AVS_OFFICESTUDIO_FILE_CROSSPLATFORM_PDF;
    this.isPDFA = true;
  }
  this.csvTxtEncoding = cmd.getCodepage();
  this.csvDelimiter = cmd.getDelimiter();
  this.csvDelimiterChar = cmd.getDelimiterChar();
  this.paid = task.getPaid();
  this.embeddedFonts = cmd.embeddedfonts;
  this.fromChanges = task.getFromChanges();
  const tenFontDir = ctx.getCfg('FileConverter.converter.fontDir', cfgFontDir);
  if (tenFontDir) {
    this.fontDir = path.resolve(tenFontDir);
  } else {
    this.fontDir = null;
  }
  const tenPresentationThemesDir = ctx.getCfg('FileConverter.converter.presentationThemesDir', cfgPresentationThemesDir);
  this.themeDir = path.resolve(tenPresentationThemesDir);
  this.mailMergeSend = cmd.mailmergesend;
  this.thumbnail = cmd.thumbnail;
  this.textParams = cmd.getTextParams();
  this.jsonParams = cmd.getJsonParams();
  this.lcid = cmd.getLCID();
  this.password = cmd.getPassword();
  this.savePassword = cmd.getSavePassword();
  this.noBase64 = cmd.getNoBase64();
  this.convertToOrigin = cmd.getConvertToOrigin();
  this.timestamp = new Date();
}
TaskQueueDataConvert.prototype = {
  serialize: function(ctx, fsPath) {
    let xml = '\ufeff<?xml version="1.0" encoding="utf-8"?>';
    xml += '<TaskQueueDataConvert xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
    xml += ' xmlns:xsd="http://www.w3.org/2001/XMLSchema">';
    xml += this.serializeXmlProp('m_sKey', this.key);
    xml += this.serializeXmlProp('m_sFileFrom', this.fileFrom);
    xml += this.serializeXmlProp('m_sFileTo', this.fileTo);
    xml += this.serializeXmlProp('m_sTitle', this.title);
    xml += this.serializeXmlProp('m_nFormatTo', this.formatTo);
    xml += this.serializeXmlProp('m_bIsPDFA', this.isPDFA);
    xml += this.serializeXmlProp('m_nCsvTxtEncoding', this.csvTxtEncoding);
    xml += this.serializeXmlProp('m_nCsvDelimiter', this.csvDelimiter);
    xml += this.serializeXmlProp('m_nCsvDelimiterChar', this.csvDelimiterChar);
    xml += this.serializeXmlProp('m_bPaid', this.paid);
    xml += this.serializeXmlProp('m_bEmbeddedFonts', this.embeddedFonts);
    xml += this.serializeXmlProp('m_bFromChanges', this.fromChanges);
    xml += this.serializeXmlProp('m_sFontDir', this.fontDir);
    xml += this.serializeXmlProp('m_sThemeDir', this.themeDir);
    if (this.mailMergeSend) {
      xml += this.serializeMailMerge(this.mailMergeSend);
    }
    if (this.thumbnail) {
      xml += this.serializeThumbnail(this.thumbnail);
    }
    if (this.textParams) {
      xml += this.serializeTextParams(this.textParams);
    }
    xml += this.serializeXmlProp('m_sJsonParams', this.jsonParams);
    xml += this.serializeXmlProp('m_nLcid', this.lcid);
    xml += this.serializeXmlProp('m_oTimestamp', this.timestamp.toISOString());
    xml += this.serializeXmlProp('m_bIsNoBase64', this.noBase64);
    xml += this.serializeXmlProp('m_sConvertToOrigin', this.convertToOrigin);
    xml += this.serializeLimit(ctx);
    xml += this.serializeOptions(ctx);
    xml += '</TaskQueueDataConvert>';
    fs.writeFileSync(fsPath, xml, {encoding: 'utf8'});
  },
  serializeHidden: function(ctx) {
    var t = this;
    return co(function* () {
      let xml;
      if (t.password || t.savePassword) {
        xml = '<TaskQueueDataConvert>';
        if(t.password) {
          let password = yield utils.decryptPassword(ctx, t.password);
          xml += t.serializeXmlProp('m_sPassword', password);
        }
        if(t.savePassword) {
          let savePassword = yield utils.decryptPassword(ctx, t.savePassword);
          xml += t.serializeXmlProp('m_sSavePassword', savePassword);
        }
        xml += '</TaskQueueDataConvert>';
      }
      return xml;
    });
  },
  serializeOptions: function (ctx) {
    const tenRequesFilteringAgent = ctx.getCfg('services.CoAuthoring.request-filtering-agent', cfgRequesFilteringAgent);
    let xml = "";
    xml += '<options>';
    xml += this.serializeXmlProp('allowNetworkRequest', true);
    xml += this.serializeXmlProp('allowPrivateIP', tenRequesFilteringAgent.allowPrivateIPAddress);
    xml += '</options>';
    return xml;
  },
  serializeMailMerge: function(data) {
    var xml = '<m_oMailMergeSend>';
    xml += this.serializeXmlProp('from', data.getFrom());
    xml += this.serializeXmlProp('to', data.getTo());
    xml += this.serializeXmlProp('subject', data.getSubject());
    xml += this.serializeXmlProp('mailFormat', data.getMailFormat());
    xml += this.serializeXmlProp('fileName', data.getFileName());
    xml += this.serializeXmlProp('message', data.getMessage());
    xml += this.serializeXmlProp('recordFrom', data.getRecordFrom());
    xml += this.serializeXmlProp('recordTo', data.getRecordTo());
    xml += this.serializeXmlProp('recordCount', data.getRecordCount());
    xml += this.serializeXmlProp('userid', data.getUserId());
    xml += this.serializeXmlProp('url', data.getUrl());
    xml += '</m_oMailMergeSend>';
    return xml;
  },
  serializeThumbnail: function(data) {
    var xml = '<m_oThumbnail>';
    xml += this.serializeXmlProp('format', data.getFormat());
    xml += this.serializeXmlProp('aspect', data.getAspect());
    xml += this.serializeXmlProp('first', data.getFirst());
    xml += this.serializeXmlProp('width', data.getWidth());
    xml += this.serializeXmlProp('height', data.getHeight());
    xml += '</m_oThumbnail>';
    return xml;
  },
  serializeTextParams: function(data) {
    var xml = '<m_oTextParams>';
    xml += this.serializeXmlProp('m_nTextAssociationType', data.getAssociation());
    xml += '</m_oTextParams>';
    return xml;
  },
  serializeLimit: function(ctx) {
    if (!inputLimitsXmlCache) {
      var xml = '<m_oInputLimits>';
      const tenInputLimits = ctx.getCfg('FileConverter.converter.inputLimits', cfgInputLimits);
      for (let i = 0; i < tenInputLimits.length; ++i) {
        let limit = tenInputLimits[i];
        if (limit.type && limit.zip) {
          xml += '<m_oInputLimit';
          xml += this.serializeXmlAttr('type', limit.type);
          xml += '>';
          xml += '<m_oZip';
          if (limit.zip.compressed) {
            xml += this.serializeXmlAttr('compressed', bytes.parse(limit.zip.compressed));
          }
          if (limit.zip.uncompressed) {
            xml += this.serializeXmlAttr('uncompressed', bytes.parse(limit.zip.uncompressed));
          }
          xml += this.serializeXmlAttr('template', limit.zip.template);
          xml += '/>';
          xml += '</m_oInputLimit>';
        }
      }
      xml += '</m_oInputLimits>';
      inputLimitsXmlCache = xml;
    }
    return inputLimitsXmlCache;
  },
  serializeXmlProp: function(name, value) {
    var xml = '';
    if (null != value) {
      xml += '<' + name + '>';
      xml += utils.encodeXml(value.toString());
      xml += '</' + name + '>';
    } else {
      xml += '<' + name + ' xsi:nil="true" />';
    }
    return xml;
  },
  serializeXmlAttr: function(name, value) {
    var xml = '';
    if (null != value) {
      xml += ' ' + name + '=\"';
      xml += utils.encodeXml(value.toString());
      xml += '\"';
    }
    return xml;
  }
};

function getTempDir() {
  var tempDir = os.tmpdir();
  var now = new Date();
  var newTemp;
  while (!newTemp || fs.existsSync(newTemp)) {
    var newName = [TEMP_PREFIX, now.getFullYear(), now.getMonth(), now.getDate(),
      '-', (Math.random() * 0x100000000 + 1).toString(36)
    ].join('');
    newTemp = path.join(tempDir, newName);
  }
  fs.mkdirSync(newTemp);
  var sourceDir = path.join(newTemp, 'source');
  fs.mkdirSync(sourceDir);
  var resultDir = path.join(newTemp, 'result');
  fs.mkdirSync(resultDir);
  return {temp: newTemp, source: sourceDir, result: resultDir};
}
function* isUselessConvertion(ctx, task, cmd) {
  if (task.getFromChanges() && 'sfc' === cmd.getCommand()) {
    let selectRes = yield taskResult.select(ctx, cmd.getDocId());
    let row = selectRes.length > 0 ? selectRes[0] : null;
    if (utils.isUselesSfc(row, cmd)) {
      ctx.logger.warn('isUselessConvertion return true. row=%j', row);
      return constants.CONVERT_PARAMS;
    }
  }
  return constants.NO_ERROR;
}
function* replaceEmptyFile(ctx, fileFrom, ext, _lcid) {
  const tenNewFileTemplate = ctx.getCfg('services.CoAuthoring.server.newFileTemplate', cfgNewFileTemplate);
  if (!fs.existsSync(fileFrom) ||  0 === fs.lstatSync(fileFrom).size) {
    let locale = 'en-US';
    if (_lcid) {
      let localeNew = lcid.from(_lcid);
      if (localeNew) {
        localeNew = localeNew.replace(/_/g, '-');
        if (fs.existsSync(path.join(tenNewFileTemplate, localeNew))) {
          locale = localeNew;
        } else {
          ctx.logger.debug('replaceEmptyFile empty locale dir locale=%s', localeNew);
        }
      }
    }
    ctx.logger.debug('replaceEmptyFile format=%s locale=%s', ext, locale);
    let format = formatChecker.getFormatFromString(ext);
    if (formatChecker.isDocumentFormat(format)) {
      fs.copyFileSync(path.join(tenNewFileTemplate, locale, 'new.docx'), fileFrom);
    } else if (formatChecker.isSpreadsheetFormat(format)) {
      fs.copyFileSync(path.join(tenNewFileTemplate, locale, 'new.xlsx'), fileFrom);
    } else if (formatChecker.isPresentationFormat(format)) {
      fs.copyFileSync(path.join(tenNewFileTemplate, locale, 'new.pptx'), fileFrom);
    }
  }
}
function* downloadFile(ctx, uri, fileFrom, withAuthorization, filterPrivate, opt_headers) {
  const tenMaxDownloadBytes = ctx.getCfg('FileConverter.converter.maxDownloadBytes', cfgMaxDownloadBytes);
  const tenDownloadTimeout = ctx.getCfg('FileConverter.converter.downloadTimeout', cfgDownloadTimeout);
  const tenDownloadAttemptMaxCount = ctx.getCfg('FileConverter.converter.downloadAttemptMaxCount', cfgDownloadAttemptMaxCount);
  const tenDownloadAttemptDelay = ctx.getCfg('FileConverter.converter.downloadAttemptDelay', cfgDownloadAttemptDelay);
  var res = constants.CONVERT_DOWNLOAD;
  var data = null;
  var sha256 = null;
  var downloadAttemptCount = 0;
  var urlParsed = url.parse(uri);
  var filterStatus = yield* utils.checkHostFilter(ctx, urlParsed.hostname);
  if (0 == filterStatus) {
    while (constants.NO_ERROR !== res && downloadAttemptCount++ < tenDownloadAttemptMaxCount) {
      try {
        let authorization;
        if (utils.canIncludeOutboxAuthorization(ctx, uri) && withAuthorization) {
          let secret = yield tenantManager.getTenantSecret(ctx, commonDefines.c_oAscSecretType.Outbox);
          authorization = utils.fillJwtForRequest(ctx, {url: uri}, secret, false);
        }
        let getRes = yield utils.downloadUrlPromise(ctx, uri, tenDownloadTimeout, tenMaxDownloadBytes, authorization, filterPrivate, opt_headers);
        data = getRes.body;
        sha256 = getRes.sha256;
        res = constants.NO_ERROR;
      } catch (err) {
        res = constants.CONVERT_DOWNLOAD;
        ctx.logger.error('error downloadFile:url=%s;attempt=%d;code:%s;connect:%s %s', uri, downloadAttemptCount, err.code, err.connect, err.stack);
        if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') {
          break;
        } else if (err.code === 'EMSGSIZE') {
          res = constants.CONVERT_LIMITS;
          break;
        } else {
          yield utils.sleep(tenDownloadAttemptDelay);
        }
      }
    }
    if (constants.NO_ERROR === res) {
      ctx.logger.debug('downloadFile complete filesize=%d sha256=%s', data.length, sha256);
      fs.writeFileSync(fileFrom, data);
    }
  } else {
    ctx.logger.error('checkIpFilter error:url=%s;code:%s;', uri, filterStatus);
    res = constants.CONVERT_DOWNLOAD;
  }
  return res;
}
function* downloadFileFromStorage(ctx, strPath, dir, opt_specialDir) {
  const tenMaxDownloadBytes = ctx.getCfg('FileConverter.converter.maxDownloadBytes', cfgMaxDownloadBytes);
  var list = yield storage.listObjects(ctx, strPath, opt_specialDir);
  ctx.logger.debug('downloadFileFromStorage list %s', list.toString());
  var dirsToCreate = [];
  var dirStruct = {};
  list.forEach(function(file) {
    var curDirPath = dir;
    var curDirStruct = dirStruct;
    var parts = storage.getRelativePath(strPath, file).split('/');
    for (var i = 0; i < parts.length - 1; ++i) {
      var part = parts[i];
      curDirPath = path.join(curDirPath, part);
      if (!curDirStruct[part]) {
        curDirStruct[part] = {};
        dirsToCreate.push(curDirPath);
      }
    }
  });
  for (var i = 0; i < dirsToCreate.length; ++i) {
    fs.mkdirSync(dirsToCreate[i]);
  }
  for (var i = 0; i < list.length; ++i) {
    var file = list[i];
    var fileRel = storage.getRelativePath(strPath, file);
    var data = yield storage.getObject(ctx, file, opt_specialDir);
    fs.writeFileSync(path.join(dir, fileRel), data);
  }
  return list.length;
}
function* processDownloadFromStorage(ctx, dataConvert, cmd, task, tempDirs, authorProps) {
  const tenEditor = ctx.getCfg('services.CoAuthoring.editor', cfgEditor);
  let res = constants.NO_ERROR;
  let concatDir;
  let concatTemplate;
  if (task.getFromOrigin() || task.getFromSettings()) {
    if (task.getFromChanges()) {
      let changesDir = path.join(tempDirs.source, constants.CHANGES_NAME);
      fs.mkdirSync(changesDir);
      let filesCount = yield* downloadFileFromStorage(ctx, cmd.getSaveKey(), changesDir);
      if (filesCount > 0) {
        concatDir = changesDir;
        concatTemplate = "changes0";
      } else {
        dataConvert.fromChanges = false;
        task.setFromChanges(dataConvert.fromChanges);
      }
    }
    dataConvert.fileFrom = path.join(tempDirs.source, 'origin.' + cmd.getFormat());
  } else {
    yield* downloadFileFromStorage(ctx, cmd.getSaveKey(), tempDirs.source);
    let format = cmd.getFormat() || 'bin';
    dataConvert.fileFrom = path.join(tempDirs.source, 'Editor.' + format);
    concatDir = tempDirs.source;
  }
  if (!utils.checkPathTraversal(ctx, dataConvert.key, tempDirs.source, dataConvert.fileFrom)) {
    return constants.CONVERT_PARAMS;
  }
  let mailMergeSend = cmd.getMailMergeSend();
  if (mailMergeSend) {
    yield* downloadFileFromStorage(ctx, mailMergeSend.getJsonKey(), tempDirs.source);
    concatDir = tempDirs.source;
  }
  if (concatDir) {
    yield* concatFiles(concatDir, concatTemplate);
    if (concatTemplate) {
      let filenames = fs.readdirSync(concatDir);
      filenames.forEach(file => {
        if (file.match(new RegExp(`${concatTemplate}\\d+\\.`))) {
          fs.rmSync(path.join(concatDir, file));
        }
      });
    }
  }
  if (task.getFromChanges() && !(task.getFromOrigin() || task.getFromSettings())) {
    if(tenEditor['binaryChanges']) {
      res = yield* processChangesBin(ctx, tempDirs, task, cmd, authorProps);
    } else {
      res = yield* processChangesBase64(ctx, tempDirs, task, cmd, authorProps);
    }
  }
  if (!fs.existsSync(dataConvert.fileFrom)) {
    if (fs.existsSync(path.join(tempDirs.source, 'origin.docx'))) {
      dataConvert.fileFrom = path.join(tempDirs.source, 'origin.docx');
    } else if (fs.existsSync(path.join(tempDirs.source, 'origin.xlsx'))) {
      dataConvert.fileFrom = path.join(tempDirs.source, 'origin.xlsx');
    } else if (fs.existsSync(path.join(tempDirs.source, 'origin.pptx'))) {
      dataConvert.fileFrom = path.join(tempDirs.source, 'origin.pptx');
    }
    let fileFromNew = path.join(path.dirname(dataConvert.fileFrom), "Editor.bin");
    fs.renameSync(dataConvert.fileFrom, fileFromNew);
    dataConvert.fileFrom = fileFromNew;
  }
  return res;
}

function* concatFiles(source, template) {
  template = template || "Editor";
  let list = yield utils.listObjects(source, true);
  list.sort(utils.compareStringByLength);
  let writeStreams = {};
  for (let i = 0; i < list.length; ++i) {
    let file = list[i];
    if (file.match(new RegExp(`${template}\\d+\\.`))) {
      let target = file.replace(new RegExp(`(${template})\\d+(\\..*)`), '$1$2');
      let writeStream = writeStreams[target];
      if (!writeStream) {
        writeStream = yield utils.promiseCreateWriteStream(target);
        writeStreams[target] = writeStream;
      }
      let readStream = yield utils.promiseCreateReadStream(file);
      yield utils.pipeStreams(readStream, writeStream, false);
    }
  }
  for (let i in writeStreams) {
    if (writeStreams.hasOwnProperty(i)) {
      writeStreams[i].end();
    }
  }
}
function* processChangesBin(ctx, tempDirs, task, cmd, authorProps) {
  const tenStreamWriterBufferSize = ctx.getCfg('FileConverter.converter.streamWriterBufferSize', cfgStreamWriterBufferSize);
  const tenMaxRequestChanges = ctx.getCfg('services.CoAuthoring.server.maxRequestChanges', cfgMaxRequestChanges);
  let res = constants.NO_ERROR;
  let changesDir = path.join(tempDirs.source, constants.CHANGES_NAME);
  fs.mkdirSync(changesDir);
  let indexFile = 0;
  let changesAuthor = null;
  let changesAuthorUnique = null;
  let changesIndex = null;
  let changesHistory = {
    serverVersion: commonDefines.buildVersion,
    changes: []
  };
  let forceSave = cmd.getForceSave();
  let forceSaveTime;
  let forceSaveIndex = Number.MAX_VALUE;
  if (forceSave && undefined !== forceSave.getTime() && undefined !== forceSave.getIndex()) {
    forceSaveTime = forceSave.getTime();
    forceSaveIndex = forceSave.getIndex();
  }
  let extChangeInfo = cmd.getExternalChangeInfo();
  let extChanges;
  if (extChangeInfo) {
    extChanges = [{
      id: cmd.getDocId(), change_id: 0, change_data: Buffer.alloc(0), user_id: extChangeInfo.user_id,
      user_id_original: extChangeInfo.user_id_original, user_name: extChangeInfo.user_name,
      change_date: new Date(extChangeInfo.change_date)
    }];
  }

  let streamObj = yield* streamCreateBin(ctx, changesDir, indexFile++, {highWaterMark: tenStreamWriterBufferSize});
  yield* streamWriteBin(streamObj, Buffer.from(utils.getChangesFileHeader(), 'utf-8'));
  let curIndexStart = 0;
  let curIndexEnd = Math.min(curIndexStart + tenMaxRequestChanges, forceSaveIndex);
  while (curIndexStart < curIndexEnd || extChanges) {
    let changes = [];
    if (curIndexStart < curIndexEnd) {
      changes = yield baseConnector.getChangesPromise(ctx, cmd.getDocId(), curIndexStart, curIndexEnd, forceSaveTime);
      if (changes.length > 0 && changes[0].change_data.subarray(0, 'ENCRYPTED;'.length).includes('ENCRYPTED;')) {
        ctx.logger.warn('processChanges encrypted changes');
        res = constants.EDITOR_CHANGES;
      }
      res = yield* isUselessConvertion(ctx, task, cmd);
      if (constants.NO_ERROR !== res) {
        break;
      }
    }
    if (0 === changes.length && extChanges) {
      changes = extChanges;
    }
    extChanges = undefined;
    for (let i = 0; i < changes.length; ++i) {
      let change = changes[i];
      if (null === changesAuthor || changesAuthor !== change.user_id_original) {
        if (null !== changesAuthor) {
          yield* streamEndBin(streamObj);
          streamObj = yield* streamCreateBin(ctx, changesDir, indexFile++);
          yield* streamWriteBin(streamObj, Buffer.from(utils.getChangesFileHeader(), 'utf-8'));
        }
        let strDate = baseConnector.getDateTime(change.change_date);
        changesHistory.changes.push({'created': strDate, 'user': {'id': change.user_id_original, 'name': change.user_name}});
      }
      changesAuthor = change.user_id_original;
      changesAuthorUnique = change.user_id;
      yield* streamWriteBin(streamObj, change.change_data);
      streamObj.isNoChangesInFile = false;
    }
    if (changes.length > 0) {
      authorProps.lastModifiedBy = changes[changes.length - 1].user_name;
      authorProps.modified = changes[changes.length - 1].change_date.toISOString().slice(0, 19) + 'Z';
    }
    if (changes.length === curIndexEnd - curIndexStart) {
      curIndexStart += tenMaxRequestChanges;
      curIndexEnd = Math.min(curIndexStart + tenMaxRequestChanges, forceSaveIndex);
    } else {
      break;
    }
  }
  yield* streamEndBin(streamObj);
  if (streamObj.isNoChangesInFile) {
    fs.unlinkSync(streamObj.filePath);
  }
  if (null !== changesAuthorUnique) {
    changesIndex = utils.getIndexFromUserId(changesAuthorUnique, changesAuthor);
  }
  if (null == changesAuthor && null == changesIndex && forceSave && undefined !== forceSave.getAuthorUserId() &&
    undefined !== forceSave.getAuthorUserIndex()) {
    changesAuthor = forceSave.getAuthorUserId();
    changesIndex = forceSave.getAuthorUserIndex();
  }
  cmd.setUserId(changesAuthor);
  cmd.setUserIndex(changesIndex);
  fs.writeFileSync(path.join(tempDirs.result, 'changesHistory.json'), JSON.stringify(changesHistory), 'utf8');
  ctx.logger.debug('processChanges end');
  return res;
}

function* streamCreateBin(ctx, changesDir, indexFile, opt_options) {
  let fileName = constants.CHANGES_NAME + indexFile + '.bin';
  let filePath = path.join(changesDir, fileName);
  let writeStream = yield utils.promiseCreateWriteStream(filePath, opt_options);
  writeStream.on('error', function(err) {
    ctx.logger.error('WriteStreamError %s', err.stack);
  });
  return {writeStream: writeStream, filePath: filePath, isNoChangesInFile: true};
}

function* streamWriteBin(streamObj, buf) {
  if (!streamObj.writeStream.write(buf)) {
    yield utils.promiseWaitDrain(streamObj.writeStream);
  }
}

function* streamEndBin(streamObj) {
  streamObj.writeStream.end();
  yield utils.promiseWaitClose(streamObj.writeStream);
}
function* processChangesBase64(ctx, tempDirs, task, cmd, authorProps) {
  const tenStreamWriterBufferSize = ctx.getCfg('FileConverter.converter.streamWriterBufferSize', cfgStreamWriterBufferSize);
  const tenMaxRequestChanges = ctx.getCfg('services.CoAuthoring.server.maxRequestChanges', cfgMaxRequestChanges);
  let res = constants.NO_ERROR;
  let changesDir = path.join(tempDirs.source, constants.CHANGES_NAME);
  fs.mkdirSync(changesDir);
  let indexFile = 0;
  let changesAuthor = null;
  let changesAuthorUnique = null;
  let changesIndex = null;
  let changesHistory = {
    serverVersion: commonDefines.buildVersion,
    changes: []
  };
  let forceSave = cmd.getForceSave();
  let forceSaveTime;
  let forceSaveIndex = Number.MAX_VALUE;
  if (forceSave && undefined !== forceSave.getTime() && undefined !== forceSave.getIndex()) {
    forceSaveTime = forceSave.getTime();
    forceSaveIndex = forceSave.getIndex();
  }
  let extChangeInfo = cmd.getExternalChangeInfo();
  let extChanges;
  if (extChangeInfo) {
    extChanges = [{
      id: cmd.getDocId(), change_id: 0, change_data: "", user_id: extChangeInfo.user_id,
      user_id_original: extChangeInfo.user_id_original, user_name: extChangeInfo.user_name,
      change_date: new Date(extChangeInfo.change_date)
    }];
  }

  let streamObj = yield* streamCreate(ctx, changesDir, indexFile++, {highWaterMark: tenStreamWriterBufferSize});
  let curIndexStart = 0;
  let curIndexEnd = Math.min(curIndexStart + tenMaxRequestChanges, forceSaveIndex);
  while (curIndexStart < curIndexEnd || extChanges) {
    let changes = [];
    if (curIndexStart < curIndexEnd) {
      changes = yield baseConnector.getChangesPromise(ctx, cmd.getDocId(), curIndexStart, curIndexEnd, forceSaveTime);
      if (changes.length > 0 && changes[0].change_data.startsWith('ENCRYPTED;')) {
        ctx.logger.warn('processChanges encrypted changes');
        res = constants.EDITOR_CHANGES;
      }
      res = yield* isUselessConvertion(ctx, task, cmd);
      if (constants.NO_ERROR !== res) {
        break;
      }
    }
    if (0 === changes.length && extChanges) {
      changes = extChanges;
    }
    extChanges = undefined;
    for (let i = 0; i < changes.length; ++i) {
      let change = changes[i];
      if (null === changesAuthor || changesAuthor !== change.user_id_original) {
        if (null !== changesAuthor) {
          yield* streamEnd(streamObj, ']');
          streamObj = yield* streamCreate(ctx, changesDir, indexFile++);
        }
        let strDate = baseConnector.getDateTime(change.change_date);
        changesHistory.changes.push({'created': strDate, 'user': {'id': change.user_id_original, 'name': change.user_name}});
        yield* streamWrite(streamObj, '[');
      } else {
        yield* streamWrite(streamObj, ',');
      }
      changesAuthor = change.user_id_original;
      changesAuthorUnique = change.user_id;
      yield* streamWrite(streamObj, change.change_data);
      streamObj.isNoChangesInFile = false;
    }
    if (changes.length > 0) {
      authorProps.lastModifiedBy = changes[changes.length - 1].user_name;
      authorProps.modified = changes[changes.length - 1].change_date.toISOString().slice(0, 19) + 'Z';
    }
    if (changes.length === curIndexEnd - curIndexStart) {
      curIndexStart += tenMaxRequestChanges;
      curIndexEnd = Math.min(curIndexStart + tenMaxRequestChanges, forceSaveIndex);
    } else {
      break;
    }
  }
  yield* streamEnd(streamObj, ']');
  if (streamObj.isNoChangesInFile) {
    fs.unlinkSync(streamObj.filePath);
  }
  if (null !== changesAuthorUnique) {
    changesIndex = utils.getIndexFromUserId(changesAuthorUnique, changesAuthor);
  }
  if (null == changesAuthor && null == changesIndex && forceSave && undefined !== forceSave.getAuthorUserId() &&
    undefined !== forceSave.getAuthorUserIndex()) {
    changesAuthor = forceSave.getAuthorUserId();
    changesIndex = forceSave.getAuthorUserIndex();
  }
  cmd.setUserId(changesAuthor);
  cmd.setUserIndex(changesIndex);
  fs.writeFileSync(path.join(tempDirs.result, 'changesHistory.json'), JSON.stringify(changesHistory), 'utf8');
  ctx.logger.debug('processChanges end');
  return res;
}

function* streamCreate(ctx, changesDir, indexFile, opt_options) {
  let fileName = constants.CHANGES_NAME + indexFile + '.json';
  let filePath = path.join(changesDir, fileName);
  let writeStream = yield utils.promiseCreateWriteStream(filePath, opt_options);
  writeStream.on('error', function(err) {
    ctx.logger.error('WriteStreamError %s', err.stack);
  });
  return {writeStream: writeStream, filePath: filePath, isNoChangesInFile: true};
}

function* streamWrite(streamObj, text) {
  if (!streamObj.writeStream.write(text, 'utf8')) {
    yield utils.promiseWaitDrain(streamObj.writeStream);
  }
}

function* streamEnd(streamObj, text) {
  streamObj.writeStream.end(text, 'utf8');
  yield utils.promiseWaitClose(streamObj.writeStream);
}
function* processUploadToStorage(ctx, dir, storagePath, calcChecksum, opt_specialDirDst) {
  var list = yield utils.listObjects(dir);
  if (list.length < MAX_OPEN_FILES) {
    yield* processUploadToStorageChunk(ctx, list, dir, storagePath, calcChecksum, opt_specialDirDst);
  } else {
    for (var i = 0, j = list.length; i < j; i += MAX_OPEN_FILES) {
      yield* processUploadToStorageChunk(ctx, list.slice(i, i + MAX_OPEN_FILES), dir, storagePath, calcChecksum, opt_specialDirDst);
    }
  }
}
function* processUploadToStorageChunk(ctx, list, dir, storagePath, calcChecksum, opt_specialDirDst) {
  let promises = list.reduce(function(r, curValue) {
    let localValue = storagePath + '/' + curValue.substring(dir.length + 1);
    let checksum;
    if (calcChecksum) {
      checksum = utils.checksumFile('sha256', curValue).then(result => {
        ctx.logger.debug('processUploadToStorageChunk path=%s; sha256=%s', localValue, result);
      });
    }
    let upload = storage.uploadObject(ctx, localValue, curValue, opt_specialDirDst);
    r.push(checksum, upload);
    return r;
  }, []);
  yield Promise.all(promises);
}
function* processUploadToStorageErrorFile(ctx, dataConvert, tempDirs, childRes, exitCode, exitSignal, error) {
  const tenErrorFiles = ctx.getCfg('FileConverter.converter.errorfiles', cfgErrorFiles);
  if (!tenErrorFiles) {
    return;
  }
  let output = '';
  if (undefined !== childRes.stdout) {
    output += `stdout:${childRes.stdout}\n`;
  }
  if (undefined !== childRes.stderr) {
    output += `stderr:${childRes.stderr}\n`;
  }
  output += `ExitCode (code=${exitCode};signal=${exitSignal};error:${error})`;
  let outputPath = path.join(tempDirs.temp, 'console.txt');
  fs.writeFileSync(outputPath, output, {encoding: 'utf8'});

  let format = path.extname(dataConvert.fileFrom).substring(1) || "unknown";

  yield* processUploadToStorage(ctx, tempDirs.temp, format + '/' + dataConvert.key , false, tenErrorFiles);
  ctx.logger.debug('processUploadToStorage error complete(id=%s)', dataConvert.key);
}
function writeProcessOutputToLog(ctx, childRes, isDebug) {
  if (childRes) {
    if (undefined !== childRes.stdout) {
      if (isDebug) {
        ctx.logger.debug('stdout:%s', childRes.stdout);
      } else {
        ctx.logger.error('stdout:%s', childRes.stdout);
      }
    }
    if (undefined !== childRes.stderr) {
      if (isDebug) {
        ctx.logger.debug('stderr:%s', childRes.stderr);
      } else {
        ctx.logger.error('stderr:%s', childRes.stderr);
      }
    }
  }
}
function* postProcess(ctx, cmd, dataConvert, tempDirs, childRes, error, isTimeout) {
  var exitCode = 0;
  var exitSignal = null;
  if(childRes) {
    exitCode = childRes.status;
    exitSignal = childRes.signal;
  }
  if (0 !== exitCode || null !== exitSignal) {
    if (-1 !== exitCodesReturn.indexOf(-exitCode)) {
      error = -exitCode;
    } else if(isTimeout) {
      error = constants.CONVERT_TIMEOUT;
    } else {
      error = constants.CONVERT;
    }
    if (-1 !== exitCodesMinorError.indexOf(error)) {
      writeProcessOutputToLog(ctx, childRes, true);
      ctx.logger.debug('ExitCode (code=%d;signal=%s;error:%d)', exitCode, exitSignal, error);
    } else {
      writeProcessOutputToLog(ctx, childRes, false);
      ctx.logger.error('ExitCode (code=%d;signal=%s;error:%d)', exitCode, exitSignal, error);
      yield* processUploadToStorageErrorFile(ctx, dataConvert, tempDirs, childRes, exitCode, exitSignal, error);
    }
  } else {
    writeProcessOutputToLog(ctx, childRes, true);
    ctx.logger.debug('ExitCode (code=%d;signal=%s;error:%d)', exitCode, exitSignal, error);
  }
  if (-1 !== exitCodesUpload.indexOf(error)) {
    let calcChecksum = (0 === (constants.AVS_OFFICESTUDIO_FILE_CANVAS & cmd.getOutputFormat()));
    yield* processUploadToStorage(ctx, tempDirs.result, dataConvert.key, calcChecksum);
    ctx.logger.debug('processUploadToStorage complete');
  }
  cmd.setStatusInfo(error);
  var existFile = false;
  try {
    existFile = fs.lstatSync(dataConvert.fileTo).isFile();
  } catch (err) {
    existFile = false;
  }
  if (!existFile) {
    var fileToBasename = path.basename(dataConvert.fileTo, path.extname(dataConvert.fileTo));
    var fileToDir = path.dirname(dataConvert.fileTo);
    var files = fs.readdirSync(fileToDir);
    for (var i = 0; i < files.length; ++i) {
      var fileCur = files[i];
      if (0 == fileCur.indexOf(fileToBasename)) {
        dataConvert.fileTo = path.join(fileToDir, fileCur);
        break;
      }
    }
  }
  cmd.setOutputPath(path.basename(dataConvert.fileTo));
  if(!cmd.getTitle()){
    cmd.setTitle(cmd.getOutputPath());
  }

  var queueData = new commonDefines.TaskQueueData();
  queueData.setCtx(ctx);
  queueData.setCmd(cmd);
  ctx.logger.debug('output (data=%j)', queueData);
  return queueData;
}

function* spawnProcess(ctx, builderParams, tempDirs, dataConvert, authorProps, getTaskTime, task) {
  const tenX2tPath = ctx.getCfg('FileConverter.converter.x2tPath', cfgX2tPath);
  const tenDocbuilderPath = ctx.getCfg('FileConverter.converter.docbuilderPath', cfgDocbuilderPath);
  const tenArgs = ctx.getCfg('FileConverter.converter.args', cfgArgs);
  let childRes, isTimeout = false;
  let childArgs;
  if (tenArgs.length > 0) {
    childArgs = tenArgs.trim().replace(/  +/g, ' ').split(' ');
  } else {
    childArgs = [];
  }
  let processPath;
  if (!builderParams) {
    processPath = tenX2tPath;
    let paramsFile = path.join(tempDirs.temp, 'params.xml');
    dataConvert.serialize(ctx, paramsFile);
    childArgs.push(paramsFile);
    let hiddenXml = yield dataConvert.serializeHidden(ctx);
    if (hiddenXml) {
      childArgs.push(hiddenXml);
    }
  } else {
    fs.mkdirSync(path.join(tempDirs.result, 'output'));
    processPath = tenDocbuilderPath;
    childArgs.push('--check-fonts=0');
    childArgs.push('--save-use-only-names=' + tempDirs.result + '/output');
    if (builderParams.argument) {
      childArgs.push(`--argument=${JSON.stringify(builderParams.argument)}`);
    }
    childArgs.push('--options=' + dataConvert.serializeOptions(ctx));
    childArgs.push(dataConvert.fileFrom);
  }
  let timeoutId;
  try {
    const tenSpawnOptions = ctx.getCfg('FileConverter.converter.spawnOptions', cfgSpawnOptions);
    let spawnOptions = Object.assign({}, tenSpawnOptions);;
    spawnOptions.env = Object.assign({}, process.env, spawnOptions.env);
    if (authorProps.lastModifiedBy && authorProps.modified) {
      spawnOptions.env['LAST_MODIFIED_BY'] = authorProps.lastModifiedBy;
      spawnOptions.env['MODIFIED'] = authorProps.modified;
    }
    let spawnAsyncPromise = spawnAsync(processPath, childArgs, spawnOptions);
    childRes = spawnAsyncPromise.child;
    let waitMS = task.getVisibilityTimeout() * 1000 - (new Date().getTime() - getTaskTime.getTime());
    timeoutId = setTimeout(function() {
      isTimeout = true;
      timeoutId = undefined;
      childRes.stdin.end();
      childRes.stdout.destroy();
      childRes.stderr.destroy();
      childRes.kill();
    }, waitMS);
    childRes = yield spawnAsyncPromise;
  } catch (err) {
    if (null === err.status) {
      ctx.logger.error('error spawnAsync %s', err.stack);
    } else {
      ctx.logger.debug('error spawnAsync %s', err.stack);
    }
    childRes = err;
  }
  if (undefined !== timeoutId) {
    clearTimeout(timeoutId);
  }
  return {childRes: childRes, isTimeout: isTimeout};
}

function* ExecuteTask(ctx, task) {
  const tenMaxDownloadBytes = ctx.getCfg('FileConverter.converter.maxDownloadBytes', cfgMaxDownloadBytes);
  const tenForgottenFiles = ctx.getCfg('services.CoAuthoring.server.forgottenfiles', cfgForgottenFiles);
  const tenForgottenFilesName = ctx.getCfg('services.CoAuthoring.server.forgottenfilesname', cfgForgottenFilesName);
  const tenAllowPrivateIPAddressForSignedRequests = ctx.getCfg('services.CoAuthoring.server.allowPrivateIPAddressForSignedRequests', cfgAllowPrivateIPAddressForSignedRequests);
  var startDate = null;
  var curDate = null;
  if(clientStatsD) {
    startDate = curDate = new Date();
  }
  var resData;
  var tempDirs;
  var getTaskTime = new Date();
  var cmd = task.getCmd();
  var dataConvert = new TaskQueueDataConvert(ctx, task);
  ctx.logger.info('Start Task');
  var error = constants.NO_ERROR;
  tempDirs = getTempDir();
  let fileTo = task.getToFile();
  dataConvert.fileTo = fileTo ? path.join(tempDirs.result, fileTo) : '';
  let builderParams = cmd.getBuilderParams();
  let authorProps = {lastModifiedBy: null, modified: null};
  error = yield* isUselessConvertion(ctx, task, cmd);
  if (constants.NO_ERROR !== error) {
    ;
  } else if (cmd.getUrl()) {
    let format = cmd.getFormat();
    dataConvert.fileFrom = path.join(tempDirs.source, dataConvert.key + '.' + format);
    if (utils.checkPathTraversal(ctx, dataConvert.key, tempDirs.source, dataConvert.fileFrom)) {
      let url = cmd.getUrl();
      let withAuthorization = cmd.getWithAuthorization();
      let filterPrivate = !withAuthorization || !tenAllowPrivateIPAddressForSignedRequests;
      let headers;
      let fileSize;
      let wopiParams = cmd.getWopiParams();
      if (wopiParams) {
        withAuthorization = false;
        filterPrivate = !tenAllowPrivateIPAddressForSignedRequests;
        let fileInfo = wopiParams.commonInfo?.fileInfo;
        let userAuth = wopiParams.userAuth;
        fileSize = fileInfo?.Size;
        if (fileInfo?.FileUrl) {
          url = fileInfo.FileUrl;
        } else if (fileInfo?.TemplateSource) {
          url = fileInfo.TemplateSource;
        } else if (userAuth) {
          url = `${userAuth.wopiSrc}/contents?access_token=${userAuth.access_token}`;
          headers = {'X-WOPI-MaxExpectedSize': tenMaxDownloadBytes};
          wopiClient.fillStandardHeaders(ctx, headers, url, userAuth.access_token);
        }
        ctx.logger.debug('wopi url=%s; headers=%j', url, headers);
      }
      if (undefined === fileSize || fileSize > 0) {
        error = yield* downloadFile(ctx, url, dataConvert.fileFrom, withAuthorization, filterPrivate, headers);
      }
      if (constants.NO_ERROR === error) {
        yield* replaceEmptyFile(ctx, dataConvert.fileFrom, format, cmd.getLCID());
      }
      if(clientStatsD) {
        clientStatsD.timing('conv.downloadFile', new Date() - curDate);
        curDate = new Date();
      }
    } else {
      error = constants.CONVERT_PARAMS;
    }
  } else if (cmd.getSaveKey()) {
    yield* downloadFileFromStorage(ctx, cmd.getDocId(), tempDirs.source);
    ctx.logger.debug('downloadFileFromStorage complete');
    if(clientStatsD) {
      clientStatsD.timing('conv.downloadFileFromStorage', new Date() - curDate);
      curDate = new Date();
    }
    error = yield* processDownloadFromStorage(ctx, dataConvert, cmd, task, tempDirs, authorProps);
  } else if (cmd.getForgotten()) {
    yield* downloadFileFromStorage(ctx, cmd.getForgotten(), tempDirs.source, tenForgottenFiles);
    ctx.logger.debug('downloadFileFromStorage complete');
    let list = yield utils.listObjects(tempDirs.source, false);
    if (list.length > 0) {
      dataConvert.fileFrom = list[0];
      var forgottenMarkPath = tempDirs.result + '/' + tenForgottenFilesName + '.txt';
      fs.writeFileSync(forgottenMarkPath, tenForgottenFilesName, {encoding: 'utf8'});
    } else {
      error = constants.UNKNOWN;
    }
  } else if (builderParams) {
    yield* downloadFileFromStorage(ctx, cmd.getDocId(), tempDirs.source);
    ctx.logger.debug('downloadFileFromStorage complete');
    let list = yield utils.listObjects(tempDirs.source, false);
    if (list.length > 0) {
      dataConvert.fileFrom = list[0];
    }
  } else {
    error = constants.UNKNOWN;
  }
  let childRes = null;
  let isTimeout = false;
  if (constants.NO_ERROR === error) {
    ({childRes, isTimeout} = yield* spawnProcess(ctx, builderParams, tempDirs, dataConvert, authorProps, getTaskTime, task));
    if (childRes && 0 !== childRes.status && !isTimeout && task.getFromChanges()
      && constants.AVS_OFFICESTUDIO_FILE_OTHER_OOXML !== dataConvert.formatTo
      && !formatChecker.isOOXFormat(dataConvert.formatTo) && !cmd.getWopiParams()) {
      ctx.logger.warn('rollback to save changes to ooxml. See assemblyFormatAsOrigin param. formatTo=%s', formatChecker.getStringFromFormat(dataConvert.formatTo));
      let extOld = path.extname(dataConvert.fileTo);
      let extNew = '.' + formatChecker.getStringFromFormat(constants.AVS_OFFICESTUDIO_FILE_OTHER_OOXML);
      dataConvert.formatTo = constants.AVS_OFFICESTUDIO_FILE_OTHER_OOXML;
      dataConvert.fileTo = dataConvert.fileTo.slice(0, -extOld.length) + extNew;
      ({childRes, isTimeout} = yield* spawnProcess(ctx, builderParams, tempDirs, dataConvert, authorProps, getTaskTime, task));
    }
    if(clientStatsD) {
      clientStatsD.timing('conv.spawnSync', new Date() - curDate);
      curDate = new Date();
    }
  }
  resData = yield* postProcess(ctx, cmd, dataConvert, tempDirs, childRes, error, isTimeout);
  ctx.logger.debug('postProcess');
  if(clientStatsD) {
    clientStatsD.timing('conv.postProcess', new Date() - curDate);
    curDate = new Date();
  }
  if (tempDirs) {
    fs.rmSync(tempDirs.temp, { recursive: true, force: true });
    ctx.logger.debug('deleteFolderRecursive');
    if(clientStatsD) {
      clientStatsD.timing('conv.deleteFolderRecursive', new Date() - curDate);
      curDate = new Date();
    }
  }
  if(clientStatsD) {
    clientStatsD.timing('conv.allconvert', new Date() - startDate);
  }
  ctx.logger.info('End Task');
  return resData;
}
function ackTask(ctx, res, task, ack) {
  return co(function*() {
    try {
      if (!res) {
        res = createErrorResponse(ctx, task);
      }
      if (res) {
        yield queue.addResponse(res);
        ctx.logger.info('ackTask addResponse');
      }
    } catch (err) {
      ctx.logger.error('ackTask %s', err.stack);
    } finally {
      ack();
      ctx.logger.info('ackTask ack');
    }
  });
}
function receiveTaskSetTimeout(ctx, task, ack, outParams) {
  let delay = 1.1 * task.getVisibilityTimeout() * 1000;
  return setTimeout(function() {
    return co(function*() {
      outParams.isAck = true;
      ctx.logger.error('receiveTask timeout %d', delay);
      yield ackTask(ctx, null, task, ack);
      yield queue.closeOrWait();
      process.exit(1);
    });
  }, delay);
}
function receiveTask(data, ack) {
  return co(function* () {
    var res = null;
    var task = null;
    let outParams = {isAck: false};
    let timeoutId = undefined;
    let ctx = new operationContext.Context();
    try {
      task = new commonDefines.TaskQueueData(JSON.parse(data));
      if (task) {
        ctx.initFromTaskQueueData(task);
        yield ctx.initTenantCache();
        timeoutId = receiveTaskSetTimeout(ctx, task, ack, outParams);
        res = yield* ExecuteTask(ctx, task);
      }
    } catch (err) {
      ctx.logger.error(err);
    } finally {
      clearTimeout(timeoutId);
      if (!outParams.isAck) {
        yield ackTask(ctx, res, task, ack);
      }
    }
  });
}
function createErrorResponse(ctx, task){
  if (!task) {
    return null;
  }
  ctx.logger.debug('createErrorResponse');
  let cmd = task.getCmd();
  cmd.setStatusInfo(constants.CONVERT);
  let res = new commonDefines.TaskQueueData();
  res.setCtx(ctx);
  res.setCmd(cmd);
  return res;
}
function simulateErrorResponse(data){
  let task = new commonDefines.TaskQueueData(JSON.parse(data));
  let ctx = new operationContext.Context();
  ctx.initFromTaskQueueData(task);
  return createErrorResponse(ctx, task);
}
function run() {
  queue = new queueService(simulateErrorResponse);
  queue.on('task', receiveTask);
  queue.init(true, true, true, false, false, false, function(err) {
    if (null != err) {
      operationContext.global.logger.error('createTaskQueue error: %s', err.stack);
    }
  });
}
exports.run = run;
