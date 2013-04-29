# A server engine using cluster

This module is a command line wrapper around the npm module "pos". With it you
can use the POS tagger from the command line or start it as a REST Web Service.

The "pos" module  is maintained by Fortnight Labs.

#LICENSE:

This module is licensed under the Apache License v2.0

# Installation

npm install node-engine

# Include this as a module in your own project

    var engine = require('../lib/engine'),
        script = __dirname + '/server',
        opts   = {
            "workers" : 4,
            "port"    : 3000,
        };
    engine.setLevel(5);
    engine.start(script, opts);

# The server can be as simple as this:

    module.exports = function () {
        var diag    = require('node-diagnostics'),
            express = require('express'),
            app     = express();
        
        /**
         * Start the Web Server to provide both the HTML frontend and the JSON Web
         * service.
         * 
         * @param options an object containing two properties :
         *          options.context: The context (prefix on the URL) for the web 
         *                           service (e.g. http://context/resource)
         *          options.port:    The port on which the server will listen to
         */
        function start(options) {
            app.get('/', function(req, res) {
                res.end('Hello World');
            })
            
            app.listen(options.port);
        }
    
        return {
            "setLevel"      : function (level) { diag = diag.setLevel(level); },
            "unshiftPrefix" : diag.unshiftPrefix,
            "start"         : start
        };
    }();
