module.exports = function () {
    var diag    = require('node-diagnostics').setPrefix(['worker']);
    
    function start(script) {
        if (diag.level >= diag.finest) diag.log(diag.finest, 'start|script=' + script);
        var application = require(script);
        setupObservers(application, script);
    }
    
    function setupObservers(application, script) {
        process.on('message', function (msg) {
            if (msg.command === 'setLevel') {
                if (diag.level >= diag.finest) diag.log(diag.finest, 'message|setLevel|level=' + msg.level);
                application.setLevel(msg.level);
                application.unshiftPrefix(msg.id);
            } else if (msg.command === 'start') {
                if (diag.level >= diag.finest) diag.log(diag.finest, 'message|start|options=' + JSON.stringify(msg.options));
                application.start(msg.options);
            } else  {
                if (diag.level >= diag.warning) diag.log(diag.warning, 'message|UNKNOWN|message=' + JSON.stringify(msg));
            }
        });
    }
    
    return {
        "setLevel"  : function (level) { diag = diag.setLevel(level); },
        "start"     : start
    };
}();