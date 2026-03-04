const fs = require("fs");
const myConsole = new console.Console(fs.createWriteStream("./logs.txt"));


const VerifyToken = (req, res) => {
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("mode:", mode);
  console.log("token:", token);
  console.log("challenge:", challenge);
  console.log("env:", VERIFY_TOKEN);

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
};

const ReceiveMessage = (req, res) => {
  try{
    var entry = (req.body["entry"])[0];
    var changes = (req.body["changes"])[0];
    var value = changes["value"];
    var messageObject = value["messages"];

    myConsole.log(messageObject);

    res.send("EVENT_RECEIVED");
  }catch(e){
    myConsole.log(e);
    res.send("EVENT_RECEIVED");
  }
};

module.exports = { VerifyToken, ReceiveMessage };