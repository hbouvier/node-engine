var engine = require('../lib/engine'),
    script = __dirname + '/test-app',
    opts   = {
        "workers" : 1,
        "port"    : 3000,
    };
engine.setLevel(5);
engine.start(script, opts);
