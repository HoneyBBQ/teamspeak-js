/**
 * Where each command's answer actually arrives.
 *
 * ServerQuery answers a query with nameless rows followed by `error`. The voice
 * protocol often does not: it answers `servergrouplist` with a named
 * `notifyservergrouplist` command, `clientgetuidfromclid` with
 * `notifyclientuidfromclid`, and so on. A client that only collects nameless
 * rows reports an empty success for every one of those — which this SDK did,
 * and documented as a property of the protocol.
 *
 * Notifications carry no return_code, so nothing on the wire ties one to the
 * command that caused it. The pairing is a property of the command, and this
 * table is where it lives. It was measured command by command
 * against TS3 3.13.8 and TS6 6.0.0-beta13.1, which answer identically — see
 * scripts/probe-response-shapes.mts to re-run that measurement.
 *
 * Commands not listed answer with nameless rows, or with nothing.
 */

/** How the voice protocol delivers one command's data. */
export interface ResponseSpec {
  /**
   * Notifications carrying the data, sent before the command's `error`.
   *
   * Rows of these are attributed to the command whose `error` follows them.
   * The same notification can also arrive unprompted — `notifyservergrouplist`
   * after someone else edits a group — so they are still dispatched as events.
   */
  readonly notifications?: readonly string[];
  /**
   * Keep only rows whose `invokerid` is the client itself.
   *
   * `notifychannelcreated` is broadcast for every channel anyone creates; the
   * one answering our `channelcreate` is the one we invoked.
   */
  readonly ownRowsOnly?: boolean;
  /**
   * The request parameter the answer echoes back, to tell the row that answers
   * from the same notification sent for someone else.
   *
   * `notifyclientupdated` goes out whenever any client changes, and
   * `notifychanneledited` whenever any channel does, so the row answering
   * `clientgetvariables clid=7` is the one with `clid=7`. A row that names
   * another value is no answer; one that does not carry the key is taken, as is
   * every row when the request did not carry it.
   */
  readonly echoKey?: string;
  /**
   * Notifications that answer a command wherever they fall against its
   * `error`, matched on a request field. A row that arrived before the `error`
   * counts; if none has, the command waits for one, until its timeout or
   * signal gives up.
   *
   * File transfer negotiation reports its key once the command has already
   * succeeded, echoing the `clientftfid` the request carried; that echo is the
   * only link between the two.
   */
  readonly correlated?: {
    readonly notifications: readonly string[];
    /** Request parameter the answer echoes back. */
    readonly key: string;
    /**
     * A notification that reports failure rather than data. Its `status` is an
     * ordinary server error id: an `ftinitupload` refused for permissions
     * answers `error id=0` and then this with `status=2568`.
     */
    readonly failure?: string;
  };
}

const inline = (...notifications: string[]): ResponseSpec => ({ notifications });

/** An inline answer that is also sent unprompted, for any `key` the request names. */
const echoing = (notification: string, key: string): ResponseSpec => ({
  notifications: [notification],
  echoKey: key,
});

const fileTransfer = (answer: string): ResponseSpec => ({
  correlated: {
    notifications: [answer, "notifystatusfiletransfer"],
    key: "clientftfid",
    failure: "notifystatusfiletransfer",
  },
});

/** The table behind {@link responseSpec}, by command name; exported for the tests that check it against the name tables. */
export const RESPONSES: Readonly<Record<string, ResponseSpec>> = {
  apikeyadd: inline("notifyapikeyadd"),
  apikeylist: inline("notifyapikeylist"),
  banlist: inline("notifybanlist"),
  channelclientpermlist: inline("notifychannelclientpermlist"),
  channelcreate: { notifications: ["notifychannelcreated"], ownRowsOnly: true },
  channelgetdescription: echoing("notifychanneledited", "cid"),
  channelgroupadd: inline("notifychannelgrouplist"),
  channelgroupclientlist: inline("notifychannelgroupclientlist"),
  channelgroupcopy: inline("notifychannelgrouplist"),
  channelgrouplist: inline("notifychannelgrouplist"),
  channelgrouppermlist: inline("notifychannelgrouppermlist"),
  channelpermlist: inline("notifychannelpermlist"),
  clientdbfind: inline("notifyclientdbfind"),
  clientdblist: inline("notifyclientdblist"),
  clientgetdbidfromuid: inline("notifyclientdbidfromuid"),
  clientgetids: inline("notifyclientids"),
  clientgetnamefromdbid: inline("notifyclientnamefromdbid"),
  clientgetnamefromuid: inline("notifyclientnamefromuid"),
  clientgetuidfromclid: inline("notifyclientuidfromclid"),
  clientgetvariables: echoing("notifyclientupdated", "clid"),
  clientsetserverquerylogin: inline("notifyclientserverqueryloginpassword"),
  clientpermlist: inline("notifyclientpermlist"),
  complainlist: inline("notifycomplainlist"),
  // Matched on the echoed `clid`, wherever the row falls against the `error`:
  // TeamSpeak 6 sent `error id=0` ahead of the `notifyconnectioninfo` row in
  // about 3% of the commands (6 of 240) when four were in flight at once, never
  // with one at a time (over 800 sequential commands, both servers); TeamSpeak
  // 3 never did. Rows for the same client also arrive unprompted, when the
  // target answers the server's `notifyconnectioninforequest`, so a row's
  // position says nothing about which command it answers; the echo does.
  getconnectioninfo: {
    correlated: { notifications: ["notifyconnectioninfo"], key: "clid" },
  },
  ftgetfileinfo: inline("notifyfileinfo"),
  ftgetfilelist: inline("notifyfilelist"),
  ftinitdownload: fileTransfer("notifystartdownload"),
  ftinitupload: fileTransfer("notifystartupload"),
  ftlist: inline("notifyfiletransferlist"),
  logview: inline("notifyserverlog"),
  messageget: inline("notifymessage"),
  messagelist: inline("notifymessagelist"),
  permfind: inline("notifypermfind"),
  permget: inline("notifypermget"),
  permissionlist: inline("notifypermissionlist"),
  permoverview: inline("notifypermoverview"),
  privilegekeyadd: inline("notifytokenadd"),
  privilegekeylist: inline("notifytokenlist"),
  servergetvariables: inline("notifyserverupdated"),
  servergroupadd: inline("notifyservergrouplist"),
  servergroupclientlist: inline("notifyservergroupclientlist"),
  servergroupcopy: inline("notifyservergrouplist"),
  servergrouplist: inline("notifyservergrouplist"),
  servergrouppermlist: inline("notifyservergrouppermlist"),
  servergroupsbyclientid: inline("notifyservergroupsbyclientid"),
  serverrequestconnectioninfo: inline("notifyserverconnectioninfo"),
  servertemppasswordlist: inline("notifyservertemppasswordlist"),
  tokenadd: inline("notifytokenadd"),
  tokenlist: inline("notifytokenlist"),
};

/** The response shape of a command, or undefined for plain rows. */
export function responseSpec(command: string): ResponseSpec | undefined {
  return Object.hasOwn(RESPONSES, command) ? RESPONSES[command] : undefined;
}
