const SonorService = require('./SonorService');
const logger = require('../utils/logger')('SystemService');
const { exec } = require('child_process');

class SystemService extends SonorService{
    constructor(opts = {}) {
        super(opts);
       
        logger.info('instance created.');
    }

    reboot(){
        this.notify('设备正在重启...','warn')
        exec('sudo reboot');
    }
    shutdown(){
        this.notify('设备正在关机...','warn')
        exec('sudo shutdown now');
    }
}

module.exports = SystemService;