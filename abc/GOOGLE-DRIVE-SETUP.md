# Direct Google Drive upload: setup boundary

Requested behavior: choose a saved A/B/C dataset in LUNARU, press upload, authorize Google when necessary, and upload without locating a ZIP in the phone file manager. The native-share feature is not direct Drive upload.

The repository currently has no Google OAuth client configuration. Direct upload is not implemented or enabled yet. Do not use ChatGPT connector credentials in this public website or place a client secret/access token in git.

## One-time prerequisites

In the owner's Google Cloud project, enable Google Drive API and configure Google Auth Platform consent (application identity/contact, audience and test users as needed). Create an OAuth client of type Web application with authorized JavaScript origin `https://lunarumap.github.io`. Supply its public client ID, ending in `.apps.googleusercontent.com`; a client secret is not required by the browser token model. The test account must be permitted by the configured audience.

## Small implementation after configuration

Use Google's Identity Services token client and the least-privilege `https://www.googleapis.com/auth/drive.file` scope. Create/use an app-created LUNARU folder for the authorized account. If an existing arbitrary folder is required instead, grant access through Google Picker; do not assume a pasted folder ID alone grants access under drive.file.

Use resumable Drive uploads for these large mobile datasets, with progress, cancellation, interruption handling and verification of returned file ID/size. Keep local originals after failure and after success until the user explicitly deletes them. Do not label native share completion as confirmed upload. Do not claim that uploading automatically shares a folder with a third party.

## Official references checked

- https://developers.google.com/identity/oauth2/web/guides/use-token-model
- https://developers.google.com/drive/api/guides/manage-uploads

Physical iPhone/Redmi testing and actual upload/readback are required before claiming the direct-upload feature works. This setup note is not an implementation or a successful upload result.
