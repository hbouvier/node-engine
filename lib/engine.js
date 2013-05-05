module.exports = function (config) {
    var cluster      = require('cluster'),
        master       = require('./master')(config),
        worker       = require('./worker')(config);

    function start(script, options) {
        if (cluster.isMaster) {
            return master.start(script, options);
        } else {
            return worker.start(script, options);
        }
    }
    
    return {
        "start"     : start,
        "stop"      : master.stop,
        "shutdown"  : master.shutdown,
        "reload"    : master.reload
    };
};
