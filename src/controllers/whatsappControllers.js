const VerifyToken = (req, res) => {
    res.send("Hola verificandoToken")
}

const ReceiveMessage = (req, res) => {
    res.send("Hola Received");
}

module.exports = {
    VerifyToken,
    ReceiveMessage
    
};