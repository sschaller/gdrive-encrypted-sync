import { requestUrl } from "obsidian";
import { GDriveSyncSettings } from "../settings/settings";
import { refreshAccessToken } from "./oauth";
import Logger from "../logger";
import { retryUntil } from "../utils";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

export interface DriveFileInfo {
  id: string;
  name: string;
  modifiedTime: string;
}

class DriveAPIError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export default class GDriveClient {
  constructor(
    private settings: GDriveSyncSettings,
    private logger: Logger,
  ) {}

  private async ensureAccessToken(): Promise<void> {
    if (
      this.settings.googleAccessToken &&
      this.settings.googleTokenExpiry > Date.now()
    ) {
      return;
    }
    if (!this.settings.googleRefreshToken) {
      throw new Error("Not authenticated with Google Drive");
    }
    const tokens = await refreshAccessToken(
      this.settings.googleClientId,
      this.settings.googleClientSecret,
      this.settings.googleRefreshToken,
    );
    this.settings.googleAccessToken = tokens.access_token;
    this.settings.googleTokenExpiry = Date.now() + tokens.expires_in * 1000;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.settings.googleAccessToken}`,
    };
  }

  async findOrCreateSyncFolder(name: string): Promise<string> {
    await this.ensureAccessToken();

    // Search for existing folder
    const query = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const searchResponse = await retryUntil(
      async () =>
        requestUrl({
          url: `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name)`,
          headers: this.headers(),
          throw: false,
        }),
      (res) => res.status !== 429 && res.status !== 500,
      3,
    );

    if (searchResponse.status >= 200 && searchResponse.status < 400) {
      const files = searchResponse.json.files;
      if (files && files.length > 0) {
        return files[0].id;
      }
    }

    // Create folder
    const createResponse = await requestUrl({
      url: `${DRIVE_API}/files`,
      method: "POST",
      headers: {
        ...this.headers(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
      }),
      throw: false,
    });

    if (createResponse.status < 200 || createResponse.status >= 400) {
      await this.logger.error("Failed to create sync folder", createResponse);
      throw new DriveAPIError(
        createResponse.status,
        `Failed to create sync folder, status ${createResponse.status}`,
      );
    }
    return createResponse.json.id;
  }

  async listFiles(folderId: string): Promise<DriveFileInfo[]> {
    await this.ensureAccessToken();
    const allFiles: DriveFileInfo[] = [];
    let pageToken: string | undefined;

    do {
      const query = `'${folderId}' in parents and trashed=false`;
      let url = `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name,modifiedTime)&pageSize=1000`;
      if (pageToken) {
        url += `&pageToken=${encodeURIComponent(pageToken)}`;
      }

      const response = await retryUntil(
        async () =>
          requestUrl({
            url,
            headers: this.headers(),
            throw: false,
          }),
        (res) => res.status !== 429 && res.status !== 500,
        3,
      );

      if (response.status < 200 || response.status >= 400) {
        await this.logger.error("Failed to list files", response);
        throw new DriveAPIError(
          response.status,
          `Failed to list files, status ${response.status}`,
        );
      }

      allFiles.push(...(response.json.files || []));
      pageToken = response.json.nextPageToken;
    } while (pageToken);

    return allFiles;
  }

  async uploadFile(
    folderId: string,
    name: string,
    content: ArrayBuffer,
  ): Promise<DriveFileInfo> {
    await this.ensureAccessToken();

    const metadata = JSON.stringify({
      name,
      parents: [folderId],
    });

    const boundary = "-------obsidian_gdrive_boundary";
    const encoder = new TextEncoder();

    const metadataPart = encoder.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    );
    const contentHeader = encoder.encode(
      `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const closing = encoder.encode(`\r\n--${boundary}--`);
    const contentBytes = new Uint8Array(content);

    const body = new Uint8Array(
      metadataPart.length +
        contentHeader.length +
        contentBytes.length +
        closing.length,
    );
    let offset = 0;
    body.set(metadataPart, offset);
    offset += metadataPart.length;
    body.set(contentHeader, offset);
    offset += contentHeader.length;
    body.set(contentBytes, offset);
    offset += contentBytes.length;
    body.set(closing, offset);

    const response = await retryUntil(
      async () =>
        requestUrl({
          url: `${UPLOAD_API}/files?uploadType=multipart&fields=id,name,modifiedTime`,
          method: "POST",
          headers: {
            ...this.headers(),
            "Content-Type": `multipart/related; boundary=${boundary}`,
          },
          body: body.buffer,
          throw: false,
        }),
      (res) => res.status !== 429 && res.status !== 500,
      3,
    );

    if (response.status < 200 || response.status >= 400) {
      await this.logger.error("Failed to upload file", response);
      throw new DriveAPIError(
        response.status,
        `Failed to upload file, status ${response.status}`,
      );
    }
    return response.json;
  }

  async updateFile(
    fileId: string,
    content: ArrayBuffer,
  ): Promise<DriveFileInfo> {
    await this.ensureAccessToken();

    const response = await retryUntil(
      async () =>
        requestUrl({
          url: `${UPLOAD_API}/files/${fileId}?uploadType=media&fields=id,name,modifiedTime`,
          method: "PATCH",
          headers: {
            ...this.headers(),
            "Content-Type": "application/octet-stream",
          },
          body: content,
          throw: false,
        }),
      (res) => res.status !== 429 && res.status !== 500,
      3,
    );

    if (response.status < 200 || response.status >= 400) {
      await this.logger.error("Failed to update file", response);
      throw new DriveAPIError(
        response.status,
        `Failed to update file, status ${response.status}`,
      );
    }
    return response.json;
  }

  async downloadFile(fileId: string): Promise<ArrayBuffer> {
    await this.ensureAccessToken();

    const response = await retryUntil(
      async () =>
        requestUrl({
          url: `${DRIVE_API}/files/${fileId}?alt=media`,
          headers: this.headers(),
          throw: false,
        }),
      (res) => res.status !== 429 && res.status !== 500,
      3,
    );

    if (response.status < 200 || response.status >= 400) {
      await this.logger.error("Failed to download file", response);
      throw new DriveAPIError(
        response.status,
        `Failed to download file, status ${response.status}`,
      );
    }
    return response.arrayBuffer;
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.ensureAccessToken();

    const response = await retryUntil(
      async () =>
        requestUrl({
          url: `${DRIVE_API}/files/${fileId}`,
          method: "DELETE",
          headers: this.headers(),
          throw: false,
        }),
      (res) => res.status !== 429 && res.status !== 500,
      3,
    );

    if (response.status < 200 || response.status >= 400) {
      await this.logger.error("Failed to delete file", response);
      throw new DriveAPIError(
        response.status,
        `Failed to delete file, status ${response.status}`,
      );
    }
  }
}
