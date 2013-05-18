var app = require('express')();

app.get('/', function(req, res) {
    res.end('Hello World');
});
