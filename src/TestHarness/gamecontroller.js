"use strict";

var fs = require('fs'),
    xml2js = require('xml2js'),
    uuid = require('node-uuid'),
    async = require('async'),
    path = require('path'),
    GameController = require('../common/GameController').GameController,
    QuestionHierarchy = require('../common/QuestionHierarchy'),
    util = require('../common/Utilities');


exports.gameController = function (serverConfig, model)
{
    var gameConfig = serverConfig.gameConfig,
        outputPath = serverConfig.outputPath,
        debug = serverConfig.debug;
    
    var cachedConfig = null;
    function config()
    {
        if (cachedConfig && !debug)
        {
            return cachedConfig;
        }
        else
        {
            console.log('Reading game config: ' + gameConfig);
            cachedConfig = JSON.parse(fs.readFileSync(gameConfig));
            populateConfig(cachedConfig, serverConfig);
            return cachedConfig;
        }
    }
    
    var gc = new GameController();
    
    gc.allConditionNames = function ()
    {
        var conditions = util.allDictKeys(config().conditions);
        conditions.sort();
        return conditions;
    };
    
    gc.getAvailableStagesForPlayer = function (playerState, callback)
    {
        var stageIDs = config().conditions[playerState.condition].stages;
        var allStages = config().stages;
        var stages = stageIDs.map(function (id)
        {
            return {
                id: id,
                displayName: allStages[id].displayName
            };
        });
        callback(stages);
    };
    
    gc.getStage = function (stageID, callback)
    {
        callback(config().stages[stageID]);
    };
    
    gc.getPlayerState = function (playerID, callback)
    {
        model.Student.find(playerID).on('success', function (student)
        {
            student.playerID = student.loginID;
            callback(student);
        })
        .on('failure', function (error)
        {
            callback(null);
        });
    };
    
    gc.savePlayerState = function (playerState, callback)
    {
        playerState.save().on('success', function ()
        {
            callback(playerState);
        })
        .on('failure', function (error)
        {
            callback(null);
        });
    };
    
    gc.getGameEngineForQuestionSet = function (questionSet, callback)
    {
        callback(config().engines[questionSet.parent.engineID]);
    };
    
    gc.saveQuestionSetResults = function (playerState, questionSet, text, callback)
    {
        var UUID = uuid();
        var timestamp = Date.now();
        var filename = UUID + '.xml';
        var filepath = outputPath + '/' + filename;
        fs.writeFile(filepath, text, function (error)
        {
            if (error)
            {
                callback(error);
                return;
            }
            
            // TODO: need to handle different game engines differently. This currently only works with the CL flash games.
            var parser = new xml2js.Parser()
            parser.on('end', function (data)
            {
                var scoreNode = data.SCORE_SUMMARY.Score,
                    scoreAttr = (scoreNode ? scoreNode['@'] : {}),
                    endNode = data.END_STATE,
                    endAttr = (endNode ? endNode['@'] : {}),
                    qsOutcome = model.QuestionSetOutcome.build({
                        dataFile: filename,
                        condition: playerState.condition,
                        stageID: questionSet.parent.id,
                        questionSetID: questionSet.id,
                        endTime: Math.round(timestamp / 1000),
                        elapsedMS: scoreAttr.ElapsedTime || scoreAttr.TOTAL_ELAPSED_TIME || 0,
                        score: scoreAttr.TotalScore || scoreAttr.TOTAL_SCORE || 0
                    });
                qsOutcome.setMedalString(scoreAttr.Medal || scoreAttr.MEDAL_EARNED || 'none');
                qsOutcome.setEndStateString(endAttr.STATE);
                console.log(endNode);
                console.log(endAttr);
                
                // Setting a relation implicitly does a save().
                qsOutcome.setStudent(playerState)
                .on('success', function ()
                {
                    callback();
                })
                .on('failure', function (error)
                {
                    callback(error);
                });
            });
            parser.parseString(text);
        });
    };
    
    return gc;
};

function populateConfig(config, serverConfig)
{
    // Populate engines.
    
    for (var engineID in config.engines)
    {
        config.engines[engineID] = makeEngine(config.engines[engineID]);
    }
    
    // Populate stages.
    
    for (var stageID in config.stages)
    {
        config.stages[stageID] = makeStage(stageID, config, serverConfig);
    }
}

function makeEngine(engineConfig)
{
    if (engineConfig.type == 'CLFlashGameEngine')
    {
        engineConfig.swfPath = '/fluency/games/' + engineConfig.cli_task_id;
        engineConfig.dataPath = '/fluency/data/' + engineConfig.cli_task_id;
    }
    
    engineConfig.toJSON = function ()
    {
        return engineConfig;
    };
    
    return engineConfig;
}

function makeStage(stageID, config, serverConfig)
{
    var stageConfig = config.stages[stageID];
    var engineConfig = config.engines[stageConfig.engine];
    
    var stage = new QuestionHierarchy.Stage(stageID, stageConfig.displayName, stageConfig.gameProperties);
    stage.engineID = stageConfig.engine;

    if (stageConfig.cli_fluency_task)
    {
        var engineDataPath = path.join(serverConfig.dataPath, engineConfig.cli_task_id);
        stage._cachedCLITaskConfig = null;
        
        stage.getCLITaskConfig = function (callback)
        {
            if (stage._cachedCLITaskConfig)
            {
                callback(null, stage._cachedCLITaskConfig);
            }
            else
            {
                var filepath = path.join(engineDataPath, stageConfig.cli_fluency_task, 'dataset.xml');
                console.log('Reading CLI Flash task configuration: ' + filepath);
                fs.readFile(filepath, function (err, str)
                {
                    if (err)
                    {
                        console.log('Error reading CLI Flash task config: ' + err.message);
                        return callback(err);
                    }
                    
                    var parser = new xml2js.Parser();
                    parser.on('end', function (data)
                    {
                        var taskConfig = {};
                        for (var i in data.datafile)
                        {
                            var xml = data.datafile[i]['@']['name'];
                            var id = data.datafile[i]['@']['id'];
                            var qs = new QuestionHierarchy.QuestionSet(stage, id, id, {
                                input: stageConfig.cli_fluency_task + '/' + xml
                            });
                            taskConfig[id] = qs;
                        }
                        stage._cachedCLITaskConfig = taskConfig;
                        callback(null, taskConfig);
                    });
                    parser.parseString(str);
                });
            }
        }
        
        stage.getAllQuestionSetIDs = function (callback)
        {
            stage.getCLITaskConfig(function (err, taskConfig)
            {
                if (err) return callback(null);
                callback(util.allDictKeys(taskConfig));
            });
        }
        
        stage.getQuestionSet = function (questionSetID, callback)
        {
            stage.getCLITaskConfig(function (err, taskConfig)
            {
                if (err) return callback(null);
                callback(taskConfig[questionSetID]);
            });
        }
        
        stage.getInstructionsHTML = function (baseURL, callback)
        {
            var instructionsPath = path.join(engineDataPath, 'ft_instructions.html'),
                tipsPath = path.join(engineDataPath, stageConfig.cli_fluency_task, 'ft_tips.html');
            async.map([instructionsPath, tipsPath],
                function (path, callback)
                {
                    fs.readFile(path, 'utf8', function (err, str)
                    {
                        if (err)
                        {
                            if (err.code == 'ENOENT')
                            {
                                return callback(null, '<p>Not available.</p>');
                            }
                            else
                            {
                                return callback(err);
                            }
                        }
                        
                        // Remove the <?xml...?> declaration and resolve relative image paths.
                        str = str.replace(/<\?xml [^>]*\?>/, '')
                                 .replace(/(<img src=['"])\.\//g, '$1' + baseURL + '/data/' + engineConfig.cli_task_id + '/');
                        callback(err, str);
                    });
                },
                function (error, results)
                {
                    if (error) return callback(error);
                    
                    var html = '<h2>Instructions</h2>' + results[0] + '<h2>Tips</h2>' + results[1];
                    callback(null, html);
                });
        };
    }
    else
    {
        throw "Cannot parse game stage configuration: " + JSON.stringify(stageConfig);
    }
    
    // getNextQuestionSet is random with replacement.
    stage.getNextQuestionSet = function (playerState, callback)
    {
        stage.getAllQuestionSetIDs(function (ids)
        {
            stage.getQuestionSet(ids && util.randomItem(ids), callback);
        });
    };
    
    return stage;
}

