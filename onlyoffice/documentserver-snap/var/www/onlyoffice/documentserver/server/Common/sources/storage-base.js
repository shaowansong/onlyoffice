/*
 * Copyright (C) undefined 2012-2023. All rights reserved
 *
 * undefined 
 *
 * Version: 7.5.1 (build:0)
 */


'use strict';
var config = require('config');
var utils = require('./utils');

var storage = require('./' + config.get('storage.name'));
var tenantManager = require('./tenantManager');

const cfgCacheFolderName = config.get('storage.cacheFolderName');

function getStoragePath(ctx, strPath, opt_specialDir) {
  opt_specialDir = opt_specialDir || cfgCacheFolderName;
  return opt_specialDir + '/' + tenantManager.getTenantPathPrefix(ctx) + strPath.replace(/\\/g, '/')
}

exports.headObject = function(ctx, strPath, opt_specialDir) {
  return storage.headObject(getStoragePath(ctx, strPath, opt_specialDir));
};
exports.getObject = function(ctx, strPath, opt_specialDir) {
  return storage.getObject(getStoragePath(ctx, strPath, opt_specialDir));
};
exports.createReadStream = function(ctx, strPath, opt_specialDir) {
  return storage.createReadStream(getStoragePath(ctx, strPath, opt_specialDir));
};
exports.putObject = function(ctx, strPath, buffer, contentLength, opt_specialDir) {
  return storage.putObject(getStoragePath(ctx, strPath, opt_specialDir), buffer, contentLength);
};
exports.uploadObject = function(ctx, strPath, filePath, opt_specialDir) {
  return storage.uploadObject(getStoragePath(ctx, strPath, opt_specialDir), filePath);
};
exports.copyObject = function(ctx, sourceKey, destinationKey, opt_specialDirSrc, opt_specialDirDst) {
  let storageSrc = getStoragePath(ctx, sourceKey, opt_specialDirSrc);
  let storageDst = getStoragePath(ctx, destinationKey, opt_specialDirDst);
  return storage.copyObject(storageSrc, storageDst);
};
exports.copyPath = function(ctx, sourcePath, destinationPath, opt_specialDirSrc, opt_specialDirDst) {
  let storageSrc = getStoragePath(ctx, sourcePath, opt_specialDirSrc);
  let storageDst = getStoragePath(ctx, destinationPath, opt_specialDirDst);
  return storage.listObjects(storageSrc).then(function(list) {
    return Promise.all(list.map(function(curValue) {
      return storage.copyObject(curValue, storageDst + '/' + exports.getRelativePath(storageSrc, curValue));
    }));
  });
};
exports.listObjects = function(ctx, strPath, opt_specialDir) {
  let prefix = getStoragePath(ctx, "", opt_specialDir);
  return storage.listObjects(getStoragePath(ctx, strPath, opt_specialDir)).then(function(list) {
    return list.map((currentValue) => {
      return currentValue.substring(prefix.length);
    });
  }).catch(function(e) {
    ctx.logger.error('storage.listObjects: %s', e.stack);
    return [];
  });
};
exports.deleteObject = function(ctx, strPath, opt_specialDir) {
  return storage.deleteObject(getStoragePath(ctx, strPath, opt_specialDir));
};
exports.deleteObjects = function(ctx, strPaths, opt_specialDir) {
  var StoragePaths = strPaths.map(function(curValue) {
    return getStoragePath(ctx, curValue, opt_specialDir);
  });
  return storage.deleteObjects(StoragePaths);
};
exports.deletePath = function(ctx, strPath, opt_specialDir) {
  let storageSrc = getStoragePath(ctx, strPath, opt_specialDir);
  return storage.listObjects(storageSrc).then(function(list) {
    return storage.deleteObjects(list);
  });
};
exports.getSignedUrl = function(ctx, baseUrl, strPath, urlType, optFilename, opt_creationDate, opt_specialDir) {
  return storage.getSignedUrl(ctx, baseUrl, getStoragePath(ctx, strPath, opt_specialDir), urlType, optFilename, opt_creationDate);
};
exports.getSignedUrls = function(ctx, baseUrl, strPath, urlType, opt_creationDate, opt_specialDir) {
  let storageSrc = getStoragePath(ctx, strPath, opt_specialDir);
  return storage.listObjects(storageSrc).then(function(list) {
    return Promise.all(list.map(function(curValue) {
      return storage.getSignedUrl(ctx, baseUrl, curValue, urlType, undefined, opt_creationDate);
    })).then(function(urls) {
      var outputMap = {};
      for (var i = 0; i < list.length && i < urls.length; ++i) {
        outputMap[exports.getRelativePath(storageSrc, list[i])] = urls[i];
      }
      return outputMap;
    });
  });
};
exports.getSignedUrlsArrayByArray = function(ctx, baseUrl, list, urlType, opt_specialDir) {
    return Promise.all(list.map(function(curValue) {
    let storageSrc = getStoragePath(ctx, curValue, opt_specialDir);
    return storage.getSignedUrl(ctx, baseUrl, storageSrc, urlType, undefined);
  }));
};
exports.getSignedUrlsByArray = function(ctx, baseUrl, list, optPath, urlType, opt_specialDir) {
  return exports.getSignedUrlsArrayByArray(ctx, baseUrl, list, urlType, opt_specialDir).then(function(urls) {
    var outputMap = {};
    for (var i = 0; i < list.length && i < urls.length; ++i) {
      if (optPath) {
        let storageSrc = getStoragePath(ctx, optPath, opt_specialDir);
        outputMap[exports.getRelativePath(storageSrc, list[i])] = urls[i];
      } else {
        outputMap[list[i]] = urls[i];
      }
    }
    return outputMap;
  });
};
exports.getRelativePath = function(strBase, strPath) {
  return strPath.substring(strBase.length + 1);
};
