module.exports  = function (config) {
    var cluster = require('cluster'),
        winston = require('winston');

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
        if (cluster.isMaster) {
            return require('./master')(config);
        } else {
            require('./worker')(config);
            return null;
        }
    }
    
    return engine();
};
