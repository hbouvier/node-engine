var cr      = require('complexity-report'),
    content = require('fs').readFileSync('./lib/master.js', 'utf-8'),
    list    = [];

    cr.run(content).functions.forEach(function(entry) {
        list.push({
            name  : entry.name,
            value : entry.complexity.cyclomatic
        });
    });
    list.sort(function (x,y) {
        return y.value - x.value;
    });
    console.log('Most cyclomatic-complex functions:');
    list.slice(0,6).forEach(function(entry) {
        console.log(' ', entry.name, entry.value);
    });
    