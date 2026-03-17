const { Storage } = require('@google-cloud/storage');
const path = require('path');
const fs = require('fs');

// Initialize Google Cloud Storage
// Note: We expect a 'gcs-key.json' in the backend root for authentication.
// If not found, it will try to use Default Application Credentials.
const keyPath = path.join(__dirname, 'gcs-key.json');
const storageOptions = fs.existsSync(keyPath) ? { keyFilename: keyPath } : {};
const storage = new Storage(storageOptions);

// CHANGE THIS to your bucket name after creating it in GCP Console
const BUCKET_NAME = process.env.GCS_BUCKET || 'wfolio-galleries';
const bucket = storage.bucket(BUCKET_NAME);

/**
 * Uploads a file to GCS
 * @param {Object} file - Multer file object (buffered)
 * @returns {Promise<Object>} - { id, url, title }
 */
async function uploadToGCS(file) {
    const blobName = `${Date.now()}-${file.originalname.trim().replace(/\s+/g, '-')}`;
    const blob = bucket.file(blobName);
    
    const blobStream = blob.createWriteStream({
        resumable: false,
        contentType: file.mimetype,
        metadata: {
            cacheControl: 'public, max-age=31536000',
        }
    });

    return new Promise((resolve, reject) => {
        blobStream.on('error', (err) => reject(err));
        blobStream.on('finish', async () => {
            try {
                // Make the file publicly readable
                await blob.makePublic();
                
                const publicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${blobName}`;
                resolve({
                    id: blobName,
                    url: publicUrl,
                    title: file.originalname,
                    type: file.mimetype.startsWith('image/') ? 'image' : 'video'
                });
            } catch (err) {
                reject(new Error(`Failed to make file public: ${err.message}`));
            }
        });
        blobStream.end(file.buffer);
    });
}

/**
 * Deletes a file from GCS
 * @param {string} fileName - The name/id of the file in the bucket
 */
async function deleteFromGCS(fileName) {
    try {
        await bucket.file(fileName).delete();
        console.log(`✅ Deleted ${fileName} from GCS`);
    } catch (error) {
        console.error(`❌ Failed to delete ${fileName} from GCS:`, error.message);
    }
}

module.exports = {
    uploadToGCS,
    deleteFromGCS,
    BUCKET_NAME
};
