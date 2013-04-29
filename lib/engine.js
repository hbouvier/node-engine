module.exports = function () {
    var diag    = require('node-diagnostics').setPrefix(['engine']),
        cluster = require('cluster'),
        master  = require('./master'),
        worker  = require('./worker');

    function start(script, options) {
        if (cluster.isMaster) {
            if (diag.level > diag.fine) diag.log(diag.fine, 'master|start');
            master.setLevel(diag.level);
            master.start(script, options);
        } else {
            if (diag.level > diag.fine) diag.log(diag.fine, 'worker|start');
            worker.setLevel(diag.level);
            worker.start(script, options);
        }
    }
    
    function reload() {
        master.reload();
    }
    
    return {
        "setLevel"  : function (level) { diag = diag.setLevel(level); },
        "start"     : start,
        "reload"    : reload
    };
}();
