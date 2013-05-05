module.exports = function (config) {
    var Q        = require('q'),
        cluster  = require('cluster'),
        winston  = require('winston'),
        logger   = new (winston.Logger)({
            transports: (config && config.transports) ? config.transports :
            [
                new (winston.transports.Console)({
                                                    "level"    : "info",
                                                    "json"     : false,
                                                    "colorize" : true
                }),
                new (winston.transports.File)({
                                                    "filename" : "worker.log",
                                                    "level"    : "warn",
                                                    "json"     : true,
                                                    "colorize" : false
                })
            ]                
        }),
        meta     = { 
            "module"   : "worker",
            "pid"      : process.pid
        };
    
    function start(script) {
        var deferred = Q.defer();
        meta.workerID = cluster.worker.id;
        logger.log('debug', 'W|start|script=' + script, meta);
        var application = require(script);
        setupObservers(application, script);
        return deferred.promise
    }
    
    function setupObservers(application, script) {
        process.on('message', function (msg) {
            if (msg.action === 'start') {
                logger.log('debug', 'W|message|start|options=' + JSON.stringify(msg.options), meta);
                application.start(msg.options);
            } else  {
                logger.log('debug', 'W|message|UNKNOWN|message=' + JSON.stringify(msg), meta);
            }
        });
    }
    
    return {
        "start"     : start
    };
};