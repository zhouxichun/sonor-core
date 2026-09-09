const SonorService = require('./SonorService');
const logger = require('../utils/logger')(__dirname);
const { exec } = require('child_process');

class SystemService extends SonorService{
    constructor(opts = {}) {
        super(opts);
       
        logger.info(`SystemService instance created.`);
    }

    reboot(){
        exec('sudo reboot');
    }
    shutdown(){
        exec('sudo shutdown now');
    }
}

module.exports = SystemService;