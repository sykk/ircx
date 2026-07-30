globalThis.onCommand = (arg) => {
  const call = JSON.parse(arg);
  host.send("PRIVMSG " + call.channel + " :" + call.args);
  return "sent";
};
