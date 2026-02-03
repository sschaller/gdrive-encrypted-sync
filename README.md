# Google Drive Encrypted Sync

Plugin to sync an Obsidian vault to Google Drive with end-to-end encryption.

I highly recommend not using this plugin with another sync service.
This might create problems for this plugin when determining what needs to be synced between remote and local vault.

## Features

- Desktop and mobile support
- Doesn't require any external tools
- End-to-end encryption (AES-256-GCM with PBKDF2 key derivation)
- Multiple sync profiles
- Automatic sync on fixed interval
- Manual sync
- Conflict resolution view

## Installation

Currently this plugin is not available in the Obsidian community plugins. You'll need to install it manually.

### Issues

If you find any problem please open an issue with as many details as possible.

Please also provide logs if possible, you can copy them from the settings page. Remember to enable logging first.

## Usage

### First sync

> [!IMPORTANT]
> The first sync will only work if either the remote folder or the local vault are completely **EMPTY**. If both contain files the first sync will fail.

Before syncing, you need to set up Google Cloud OAuth credentials and configure the plugin.

#### Setting up Google Cloud credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Enable the **Google Drive API**:
   - Navigate to "APIs & Services" → "Library"
   - Search for "Google Drive API" and enable it
4. Configure the **OAuth consent screen** ("APIs & Services" → "OAuth consent screen"):
   - Select "External" user type
   - Fill in the app name and your email addresses
   - Add the scope: `https://www.googleapis.com/auth/drive.file`
   - Add yourself as a test user (required while the app is in "Testing" mode)
5. Create **OAuth credentials**:
   - Go to "APIs & Services" → "Credentials" ([direct link](https://console.cloud.google.com/apis/credentials))
   - Click "Create Credentials" → "OAuth client ID"
   - Select **Web application** as the application type
   - Add an authorized redirect URI (see note below)
   - Copy the **Client ID** and **Client Secret**

> [!NOTE]
> The redirect URI must point to a hosted copy of `docs/oauth-redirect.html`. If you fork this repo and enable GitHub Pages, your redirect URI will be:
> `https://YOUR_USERNAME.github.io/YOUR_REPO_NAME/oauth-redirect.html`

#### Plugin configuration

Enter the following in the plugin settings:

- **Client ID** and **Client Secret** from Google Cloud
- **Encryption password** — used to encrypt all files (keep this safe!)
- **Sync folder name** — the folder that will be created in your Google Drive

### Encryption

All files are encrypted locally before being uploaded to Google Drive:

- **Content encryption**: Files are encrypted using AES-256-GCM
- **Filename encryption**: Original filenames are encrypted and stored as base64-encoded `.enc` files
- **Key derivation**: Your password is used with PBKDF2 (600,000 iterations) to derive the encryption key

> [!CAUTION]
> Keep your encryption password safe. If you lose it, you won't be able to decrypt your files.

### Sync modes

You can always sync manually by clicking the sync button in the side ribbon.
This will always work even if sync on interval is enabled.

The `Sync with Google Drive` command is also available.

### Conflict resolution

When you sync multiple vaults using this plugin you might risk creating conflicts between the remote and a local vault.
This usually happens when the remote has a new update from vault A, but vault B edits the file before syncing with remote.
That creates a conflict, by default we'll open a view to let you resolve the conflict since you should have all the necessary
information to correctly resolve it.

By default the split view will be used on desktop and the unified one on mobile, you can change the settings to always use the one you prefer.

If you don't want to resolve them you can change the settings to always prefer either the remote or local version in case of conflicts.

### Config sync

If you want to sync your vault configs with other vaults you can enable that.
It will sync the whole folder, that is `.obsidian` by default, including all plugins and themes.

### Reset

If you need to reset the plugin settings and metadata you can easily do that in the settings.

That will completely wipe all the sync metadata so you'll have to repeat the first sync as if you just enabled the plugin for the first time.

## FAQs

### What's different from other sync plugins?

This plugin syncs with Google Drive, and encrypts all data before uploading. Your files are stored as encrypted blobs on Google Drive, making them unreadable without your password.

Unlike plugins that require external tools, this plugin uses Google Drive's REST API directly, making it portable across desktop and mobile with identical behavior.

### Can I use this with other sync plugins?

No.

To work correctly this plugin uses a custom metadata file that is updated every time we sync. Other plugins don't know about that file, so if you sync with others too you risk losing data.

## License

The project is licensed under the [AGPLv3](https://www.gnu.org/licenses/agpl-3.0.en.html) license.

## Credits

Based on [github-gitless-sync](https://github.com/silvanocerza/github-gitless-sync) by [Silvano Cerza](https://silvanocerza.com).
