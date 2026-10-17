---
"@honeybbq/teamspeak": minor
---

A raw `exec` over the voice protocol now returns the rows of `tokenadd`, `tokenlist`, `apikeyadd`, `apikeylist`, `permget`, `getconnectioninfo`, `clientgetvariables`, `servergetvariables` and `clientsetserverquerylogin`. The server answers each with a notification (`notifytokenadd`, `notifyapikeyadd`, `notifypermget`, `notifyconnectioninfo`, `notifyclientupdated`, `notifyserverupdated` and the like) and the client used to report an empty success. `CommandName` and `NotificationName` name them.
