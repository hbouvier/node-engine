module.exports = function () {
    var app = require('express')(),
        monitor = require('node-network-monitor')({
            "statsd" : {
                "host"   : "localhost",
                "port"   : 8125,
                "domain" : "engine-test"
            },
            "syslogd" : {
                "host" : "localhost",
                "port" : 514
            }
        });
    
    /**
     * Start the Web Server to provide both the HTML frontend and the JSON Web
     * service.
     * 
     * @param options an object containing two properties :
     *          options.context: The context (prefix on the URL) for the web 
     *                           service (e.g. http://context/resource)
     *          options.port:    The port on which the server will listen to
     * @param   id: when using clustering, this is the 'index' of this worker
     */
    function start(options) {
        app.get('/', function(req, res) {
            res.end('Hello World');
        });
        
        monitor.app(app.listen(options.port));
    }

    return {
        "start"         : start
    };
}();

