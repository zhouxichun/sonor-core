const logger = require('../utils/logger')('SystemService');
const { exec } = require('child_process');

class SystemService{
    static reboot(){
        logger.info('rebooting...')
        exec('sudo reboot');
    }
    static shutdown(){
        logger.info('shuting down...')
        exec('sudo shutdown now');
    }
}

module.exports = SystemService;