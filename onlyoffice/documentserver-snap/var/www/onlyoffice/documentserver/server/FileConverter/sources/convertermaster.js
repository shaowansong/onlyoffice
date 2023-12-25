/*
 * Copyright (C) undefined 2012-2023. All rights reserved
 *
 * undefined 
 *
 * Version: 7.5.1 (build:0)
 */


'use strict';

const cluster = require('cluster');
const logger = require('./../../Common/sources/logger');
const operationContext = require('./../../Common/sources/operationContext');

if (cluster.isMaster) {
  const fs = require('fs');
  const co = require('co');
  const os = require('os');
  const config = require('config');
  const license = require('./../../Common/sources/license');

  const cfgLicenseFile = config.get('license.license_file');
  const cfgMaxProcessCount = config.get('FileConverter.converter.maxprocesscount');

  var workersCount = 0;
  const readLicense = function* () {
    const numCPUs = os.cpus().length;
    const availableParallelism = os.availableParallelism?.();
    operationContext.global.logger.warn('num of CPUs: %d; availableParallelism: %s', numCPUs, availableParallelism);
    workersCount = Math.ceil((availableParallelism || numCPUs) * cfgMaxProcessCount);
    let [licenseInfo] = yield* license.readLicense(cfgLicenseFile);
    workersCount = Math.min(licenseInfo.count, workersCount);
  };
  const updateWorkers = () => {
    var i;
    const arrKeyWorkers = Object.keys(cluster.workers);
    if (arrKeyWorkers.length < workersCount) {
      for (i = arrKeyWorkers.length; i < workersCount; ++i) {
        const newWorker = cluster.fork();
        operationContext.global.logger.warn('worker %s started.', newWorker.process.pid);
      }
    } else {
      for (i = workersCount; i < arrKeyWorkers.length; ++i) {
        const killWorker = cluster.workers[arrKeyWorkers[i]];
        if (killWorker) {
          killWorker.kill();
        }
      }
    }
  };
  const updateLicense = () => {
    return co(function*() {
      try {
        yield* readLicense();
        operationContext.global.logger.warn('update cluster with %s workers', workersCount);
        updateWorkers();
      } catch (err) {
        operationContext.global.logger.error('updateLicense error: %s', err.stack);
      }
    });
  };

  cluster.on('exit', (worker, code, signal) => {
    operationContext.global.logger.warn('worker %s died (code = %s; signal = %s).', worker.process.pid, code, signal);
    updateWorkers();
  });

  updateLicense();

  fs.watchFile(cfgLicenseFile, updateLicense);
  setInterval(updateLicense, 86400000);
} else {
  const converter = require('./converter');
  converter.run();
}

process.on('uncaughtException', (err) => {
  operationContext.global.logger.error((new Date).toUTCString() + ' uncaughtException:', err.message);
  operationContext.global.logger.error(err.stack);
  logger.shutdown(() => {
    process.exit(1);
  });
});
