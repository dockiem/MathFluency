/*
    Title: Test Harness Server
    
    Implementation of the Math Fluency <test harness at http://fluencychallenge.com/wiki/DesignAndImplementation/TestHarness>.
*/

var urllib = require('url'),
    fs = require('fs'),
    express = require('express'),
    restapi = require('../server/restapi'),
    modelInit = require('./model'),
    gameController = require('./gamecontroller').gameController,
    addInstructorEndpoints = require('./instructorserver').addInstructorEndpoints,
    MySQLSessionStore = require('connect-mysql-session')(express);


function runServer(config, model)
{
    var port = config.port || 80,
        rootPath = config.rootPath || '/',
        outputPath = config.outputPath || __dirname + '/output';
    
    var gc = gameController(outputPath, config, model);
    
    var app = express.createServer();
    if (rootPath && rootPath != '/')
    {
        app.set('home', rootPath);
    }
    else
    {
        rootPath = '';
    }
    if (config.debug)
    {
        app.use(express.errorHandler({ dumpExceptions: true, showStack: true }));
        app.use(express.logger());
    }
    app.set('view engine', 'ejs');
    app.set('views', __dirname + '/views');
    
    app.use(express.bodyParser());
    app.use(express.cookieParser());
    app.use(express.session({
        store: new MySQLSessionStore(config.mysql.database, config.mysql.user, config.mysql.password, config.sequelizeOptions),
        secret: "keyboard cat",
        cookie: {
            maxAge: null
        }
    }));
    
    // Static handlers for client-side JS and game assessts, etc.
    
    app.use(rootPath + '/js/node_modules', express.static(__dirname + '/../../node_modules'));
    app.use(rootPath + '/js/common', express.static(__dirname + '/../common'));
    app.use(rootPath + '/js/client', express.static(__dirname + '/../client'));
    app.use(rootPath + '/js', express.static(__dirname + '/clientjs'));
    app.use(rootPath + '/static', express.static(__dirname + '/../static'));
    app.use(rootPath + '/static', express.directory(__dirname + '/../static', {icons:true}));
    app.use(rootPath + '/output', express.static(outputPath));
    app.use(rootPath + '/output', express.directory(outputPath, {icons:true}));
    app.use(rootPath + '/css', express.static(__dirname + '/css'));
    
    // Middleware to load student or instructor data before processing requests.
    
    app.use(function (req, res, next)
    {
        if (req.session && req.session.instructorID)
        {
            model.Instructor.find(req.session.instructorID).on('success', function (instructor)
            {
                req.instructor = instructor;
                next();
            });
        }
        else if (req.session && req.session.studentID)
        {
            gc.getPlayerState(req.session.studentID, function (student)
            {
                req.student = student;
                
                // The REST API uses req.playerState, so set that too.
                req.playerState = student;
                
                next();
            });
        }
        else next();
    });
    
    // Helpers for commonly used template variables.
    
    app.helpers({
        logoutURL: rootPath + '/logout',
        rootPath: rootPath
    });
    app.dynamicHelpers({
        loginID: function (req)
        {
            if (req.instructor) return req.instructor.loginID;
            else if (req.student) return req.student.loginID;
            else return null;
        },
        instructor: function (req)
        {
            return req.instructor;
        },
        student: function (req)
        {
            return req.student;
        }
    });
    
    // Dynamic handlers for index template -- redirect depending on whether user is logged in as student, instructor, or neither.
    
    app.get(rootPath + '/', function (req, res)
    {
        if (req.session.studentID)
            res.redirect(rootPath + '/student');
        else if (req.session.instructorID)
            res.redirect(rootPath + '/instructor');
        else
            res.redirect(rootPath + '/login')
    });
    
    // Login and logout
    
    app.get(rootPath + '/login', function (req, res)
    {
        // Redirect if already logged in.
        if (req.instructor || req.student)
        {
            res.redirect(rootPath);
        }
        else
        {
            res.render('login', {mainjs: 'login'});
        }
    });
    app.post(rootPath + '/login/:studentOrInstructor', function (req, res)
    {
        var password = req.body.password;
        var loginID = req.body.loginID;
        var remember = req.body.remember;
        var isStudent = req.params.studentOrInstructor == 'student';
        var modelClass = model[isStudent ? 'Student' : 'Instructor'];
        modelClass.authenticate(loginID, password, function (entity)
        {
            if (entity)
            {
                req.session[isStudent ? 'studentID' : 'instructorID'] = entity.id;
                if (remember)
                {
                    req.session.cookie.maxAge = config.longSessionLength;
                }
                res.send("logged in");
            }
            else
            {
                res.send('Login ID and/or password is incorrect.', 400);
            }
        });
    });
    
    app.get(rootPath + '/logout', function (req, res)
    {
        req.session.destroy();
        res.redirect('home');
    });
    
    // Instructor page and endpoints
    // Refactored to instructorserver file.
    addInstructorEndpoints(app, rootPath, gc, model, config);
    
    // Student page and endpoints
    
    app.get(rootPath + '/student', function (req, res)
    {
        if (!req.student)
        {
            res.redirect('home');
            return;
        }
        gc.getAvailableStagesForPlayer(req.student, function (stageIDs)
        {
            res.render('student', {
                mainjs: 'student',
                levels: stageIDs
            });
        });
    });
    
    // The REST API handler.
    app.use(rootPath + '/api', restapi(gc));
    
    // Start the server.
    app.listen(port);
    console.log('Test harness server running on port ' + port + ' with URL root ' + rootPath);
}

if (require.main === module)
{
    if (process.argv.length > 2)
    {
        console.log('Invalid argument(s).');
        console.log('Usage: node servermain.js [CONFIG]');
        console.log('CONFIG is a path to a server config JSON file, defaulting to serverconfig.json.');
        process.exit(1);
    }
    var configFile = process.argv[2] || './serverconfig.js',
        config = require(configFile);
    modelInit(config.mysql.database, config.mysql.user, config.mysql.password, config.sequelizeOptions, function (model)
    {
        runServer(config, model);
    });
}
