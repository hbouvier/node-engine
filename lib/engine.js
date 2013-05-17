module.exports = function (config) {
    var cluster      = require('cluster');

    function engine() {
        if (cluster.isMaster) {
            return require('./master')(config);
        } else {
            require('./worker')(config);
            return null;
        }
    }
    
    return engine();
};
