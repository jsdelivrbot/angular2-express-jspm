"use strict"
// src/models/Todo.js
var mongoose = require('mongoose');
// Create a schema for the Todo object
let todoSchema = new mongoose.Schema({
  text: String
});
// Expose the model so that it can be imported and used in the controller (to search, delete, etc)

module.exports =  mongoose.model('Todo', todoSchema);
