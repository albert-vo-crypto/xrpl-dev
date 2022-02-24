var express = require("express");
var app = express();
var path = require("path");
const xrpl = require("xrpl")
const apiKey = process.env.API_KEY
console.log(apiKey)

app.get('/',function(req,res){
  res.sendFile(path.join(__dirname+'/seller.html'));
  //__dirname : It will resolve to your project folder.
});
app.listen(3011);
