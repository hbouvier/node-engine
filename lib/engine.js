module.exports  = function (config) {
    var cluster = require('cluster'),
        winston = require('winston'),
        os      = require('os'),
        meta    = { 
            "module" : "ENGINE",
            "pid"    : process.pid
        };

    function engine() {
        if (!config.logger) {
            config.logger = new (winston.Logger)({
                transports : [
                    new (winston.transports.Console)({
                        "level"    : "error",
                        "json"     : false,
                        "colorize" : true
                    })
                ]
            });
        }
        if (!config.script) {
            config.logger.log('error', '%s: script is a require parameter!', meta.module, meta);
            process.exit(-1);
        }
        config.startTimeoutInMs    = config.startTimeoutInMs    || 60000;
        config.shutdownTimeoutInMs = config.shutdownTimeoutInMs || 60000;
        config.stopTimeoutInMs     = config.stopTimeoutInMs     ||  5000;
        config.workers             = config.workers             || os.cpus().length;
        //config.scriptArgv
        // config.scriptConfig
        
        if (cluster.isMaster) {
            return require('./master')(config);
        } else {
            require('./worker')(config);
            return null;
        }
    }
    
    return engine();
};
