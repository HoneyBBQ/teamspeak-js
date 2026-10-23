---
"@honeybbq/teamspeak": minor
---

`ServerError.failedPermission` names the permission a refusal lacked, as WebQuery reports it in `status.failed_permission` (for example `b_serverinstance_info_view` for a guest's `hostinfo`). Over WebQuery the permission was dropped, so a refusal never said which one; the voice protocol and raw or SSH ServerQuery still report an id, in `failedPermissionID`. The name is kept as the server sent it, and is `undefined` when the server named none.
