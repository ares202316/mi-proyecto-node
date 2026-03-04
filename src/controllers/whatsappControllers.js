const VerifyToken = (req, res) => {
   
    try{
        var accessToken = "NCUINC2373F8E8CB83C632EDD";
        var token = req.query("hub.verify?token");
        var challenge = req.query["hub.challenge"];

        if(challenge != null && token != null && token == accessToken){
            res.send(challenge);
        }else{
            res.status(400).send();
        }

    }catch(e){
        res.status(400).send();
    }


}

const ReceiveMessage = (req, res) => {
    res.send("Hola Received");
}

module.exports = {
    VerifyToken,
    ReceiveMessage
    
};