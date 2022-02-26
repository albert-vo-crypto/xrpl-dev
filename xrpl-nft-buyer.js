var express = require("express");
var app = express();
var path = require("path");
const xrpl = require("xrpl")


app.get('/',function(req,res){
  res.sendFile(path.join(__dirname+'/xrpl-nft-buyer.html'));
  //__dirname : It will resolve to your project folder.
});
app.listen(3021);
