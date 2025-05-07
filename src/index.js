/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const actions = require('@actions/core');
const glob = require('glob');
const { google } = require('googleapis');

const credentials = actions.getInput('credentials', { required: true });
const parentFolderId = actions.getInput('parent_folder_id', { required: true });
const targetPattern = actions.getInput('target', { required: true });
const owner = actions.getInput('owner', { required: false });
const childFolder = actions.getInput('child_folder', { required: false });
const overwrite = actions.getInput('overwrite', { required: false }) === 'true';
const overrideFilename = actions.getInput('name', { required: false }); // only used when single file match

const credentialsJSON = JSON.parse(Buffer.from(credentials, 'base64').toString());
const scopes = ['https://www.googleapis.com/auth/drive.file'];
const auth = new google.auth
    .JWT(credentialsJSON.client_email, null, credentialsJSON.private_key, scopes, owner);
const drive = google.drive({ version: 'v3', auth });

async function getUploadFolderId() {
    if (!childFolder) {
        return parentFolderId;
    }

    const { data: { files } } = await drive.files.list({
        q: `name='${childFolder}' and '${parentFolderId}' in parents and trashed=false`,
        fields: 'files(id)',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
    });

    if (files.length > 1) {
        throw new Error('More than one entry match the child folder name');
    }
    if (files.length === 1) {
        return files[0].id;
    }

    const childFolderMetadata = {
        name: childFolder,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentFolderId],
    };
    const { data: { id: childFolderId } } = await drive.files.create({
        resource: childFolderMetadata,
        fields: 'id',
        supportsAllDrives: true,
    });

    return childFolderId;
}

async function getFileId(targetFilename, folderId) {
    const { data: { files } } = await drive.files.list({
        q: `name='${targetFilename}' and '${folderId}' in parents`,
        fields: 'files(id)',
    });

    if (files.length > 1) {
        throw new Error('More than one entry match the file name');
    }
    if (files.length === 1) {
        return files[0].id;
    }

    return null;
}

async function uploadFile(target, uploadFolderId, finalName) {
    const fileData = {
        body: fs.createReadStream(target),
    };

    let fileId = null;

    if (overwrite) {
        fileId = await getFileId(finalName, uploadFolderId);
    }

    if (fileId === null) {
        actions.info(`Creating file: ${finalName}`);
        const fileMetadata = {
            name: finalName,
            parents: [uploadFolderId],
        };

        await drive.files.create({
            resource: fileMetadata,
            media: fileData,
            uploadType: 'multipart',
            fields: 'id',
            supportsAllDrives: true,
        });
    } else {
        actions.info(`Updating existing file: ${finalName}`);
        await drive.files.update({
            fileId,
            media: fileData,
        });
    }
}

async function main() {
    const uploadFolderId = await getUploadFolderId();
    const matchedFiles = glob.sync(targetPattern);

    if (matchedFiles.length === 0) {
        throw new Error(`No files matched pattern: ${targetPattern}`);
    }

    for (const file of matchedFiles) {
        const finalName = overrideFilename && matchedFiles.length === 1
            ? overrideFilename
            : path.basename(file);

        await uploadFile(file, uploadFolderId, finalName);
    }

    actions.info(`Uploaded ${matchedFiles.length} file(s) successfully.`);
}

main().catch((error) => actions.setFailed(error));
