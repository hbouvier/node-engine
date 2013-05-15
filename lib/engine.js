module.exports = function (config) {
    var cluster      = require('cluster'),
        master       = require('./master')(config),
        worker       = require('./worker')(config);

    function start(script, options) {
        if (cluster.isMaster) {
            return master.start();
        } else {
            return worker.start(script);
        }
    }
    
    return {
        "start"     : start,
        "stop"      : master.stop,
        "shutdown"  : master.shutdown,
        "restart"   : master.restart
    };
};
