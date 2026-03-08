const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const multer = require("multer"); // Phase 10 file uploads

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "wfolio_super_secret_key_123";

// Middleware
app.use(cors());
app.use(express.json());

// Expose the uploads directory publicly so the frontend can load the images/videos
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const DB_PATH = path.join(__dirname, "users.json");
const DRIVE_DB_PATH = path.join(__dirname, "drives.json");
const SITE_DB_PATH = path.join(__dirname, "site.json");

// Helper to read/write site settings
function getSiteSettings() {
    if (!fs.existsSync(SITE_DB_PATH)) {
        const defaults = { theme: "dark", accentColor: "#3b82f6", photographerName: "LensFolio Studio", tagline: "Capturing timeless moments.", bio: "", email: "", phone: "", location: "", portfolioPhotos: [], instagramUrl: "#", twitterUrl: "#", pinterestUrl: "#" };
        fs.writeFileSync(SITE_DB_PATH, JSON.stringify(defaults, null, 2));
        return defaults;
    }
    return JSON.parse(fs.readFileSync(SITE_DB_PATH, "utf8"));
}
function saveSiteSettings(settings) {
    fs.writeFileSync(SITE_DB_PATH, JSON.stringify(settings, null, 2));
}

// Define Multer storage configuration
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // We'll create a folder for each drive ID. We'll generate the ID if it doesn't exist yet in the request body, 
        // or rely on a pre-generated ID sent from the client or generated middleware.
        // For simplicity, we'll just save everything to /uploads and prefix with timestamp.
        const uploadPath = path.join(__dirname, "uploads");
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        // Generate unique name: timestamp-originalName
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname.trim().replace(/\s+/g, '-'));
    }
});
const upload = multer({ storage: storage });

// Helper to init/read Users DB
function getUsers() {
    if (!fs.existsSync(DB_PATH)) {
        fs.writeFileSync(DB_PATH, JSON.stringify([]));
        return [];
    }
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function saveUsers(users) {
    fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2));
}

// Helper to init/read Drives DB
function getDrives() {
    if (!fs.existsSync(DRIVE_DB_PATH)) {
        fs.writeFileSync(DRIVE_DB_PATH, JSON.stringify([]));
        return [];
    }
    return JSON.parse(fs.readFileSync(DRIVE_DB_PATH, "utf8"));
}

function saveDrives(drives) {
    fs.writeFileSync(DRIVE_DB_PATH, JSON.stringify(drives, null, 2));
}

// ----- AUTHENTICATION ROUTES -----
app.post("/api/auth/register", async (req, res) => {
    console.log("POST /api/auth/register body:", req.body);
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: "All fields are required" });
        }

        const users = getUsers();
        if (users.find(u => u.email === email)) {
            return res.status(400).json({ error: "User already exists" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = {
            id: Date.now().toString(),
            name,
            email,
            password: hashedPassword,
            createdAt: new Date().toISOString()
        };

        users.push(newUser);
        saveUsers(users);

        res.status(201).json({ message: "User created successfully" });
    } catch (error) {
        console.error("Register Error:", error);
        res.status(500).json({ error: "Server error during registration" });
    }
});

app.post("/api/auth/login", async (req, res) => {
    console.log("POST /api/auth/login body:", req.body);
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: "Email and password are required" });
        }

        const users = getUsers();
        const user = users.find(u => u.email === email);

        if (!user) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const token = jwt.sign(
            { id: user.id, email: user.email, name: user.name },
            JWT_SECRET,
            { expiresIn: "24h" }
        );

        res.json({
            message: "Login successful",
            token,
            user: { id: user.id, name: user.name, email: user.email }
        });
    } catch (error) {
        console.error("Login Error:", error);
        res.status(500).json({ error: "Server error during login" });
    }
});

app.get("/api/auth/me", (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "No token provided" });
    }

    const token = authHeader.split(" ")[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        res.json({ user: decoded });
    } catch (error) {
        res.status(401).json({ error: "Invalid token" });
    }
});

// ----- DRIVE MANAGEMENT ROUTES -----

// Phase 10: Local File Delivery
// Read the drive info from db and format it for the frontend Gallery UI
app.get("/api/drive/client/:driveId", (req, res) => {
    try {
        const driveId = req.params.driveId;
        const drives = getDrives();
        const targetDrive = drives.find(d => d.id === driveId);

        if (!targetDrive) {
            return res.status(404).json({ error: "Drive not found" });
        }

        // Return full drive data so all settings are restored on client/admin load
        res.json({
            ...targetDrive,
            folderId: targetDrive.id,
            totalCount: (targetDrive.images?.length || 0) + (targetDrive.videos?.length || 0)
        });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch drive files" });
    }
});

// Get all client drives created by the admin
app.get("/api/drives", (req, res) => {
    // In a real app we'd verify admin token here
    const drives = getDrives();
    res.json({ drives });
});

// Phase 10: Create a new client drive WITH file uploads
// Multer's `upload.array('files')` intercepts the request, saves the binary files, 
// and makes the text fields available in `req.body` and the file metadata in `req.files`.
app.post("/api/drives", upload.array("files"), (req, res) => {
    try {
        const { clientName } = req.body;

        if (!clientName) {
            return res.status(400).json({ error: "clientName is required" });
        }

        const driveId = Date.now().toString();
        const uploadedFiles = req.files || [];

        const images = [];
        const videos = [];

        // Categorize files based on mimetype
        uploadedFiles.forEach(file => {
            // Build the public URL (assuming frontend runs on localhost:3000 and connects here on 4000)
            const publicUrl = `http://localhost:${PORT}/uploads/${file.filename}`;
            const item = {
                id: file.filename,
                url: publicUrl,
                title: file.originalname
            };

            if (file.mimetype.startsWith('image/')) {
                item.type = 'image';
                images.push(item);
            } else if (file.mimetype.startsWith('video/')) {
                item.type = 'video';
                videos.push(item);
            }
        });

        const newDrive = {
            id: driveId,
            clientName,
            images,
            videos,
            status: "Active",
            favoritesCount: "0/0", // Mocked count for now
            createdAt: new Date().toLocaleDateString("en-US", { month: 'short', day: 'numeric', year: 'numeric' })
        };

        const drives = getDrives();
        drives.push(newDrive);
        saveDrives(drives);

        res.status(201).json({ message: "Drive created successfully", drive: newDrive });
    } catch (error) {
        console.error("Upload error:", error);
        res.status(500).json({ error: "Failed to create drive" });
    }
});

// Delete a drive and its associated files
app.delete("/api/drives/:id", (req, res) => {
    try {
        const { id } = req.params;
        const drives = getDrives();
        const drive = drives.find(d => d.id === id);

        if (!drive) {
            return res.status(404).json({ error: "Drive not found" });
        }

        // Optional: Clean up physical files
        const allMedia = [...(drive.images || []), ...(drive.videos || [])];
        allMedia.forEach(item => {
            const filename = item.id; // item.id is the filename in this implementation
            const filePath = path.join(__dirname, "uploads", filename);
            if (fs.existsSync(filePath)) {
                try {
                    fs.unlinkSync(filePath);
                } catch (e) {
                    console.error(`Failed to delete file: ${filePath}`, e);
                }
            }
        });

        const newDrives = drives.filter(d => d.id !== id);
        saveDrives(newDrives);

        res.json({ message: "Drive deleted successfully" });
    } catch (error) {
        console.error("Delete drive error:", error);
        res.status(500).json({ error: "Failed to delete drive" });
    }
});

// Add more files to an existing drive
app.patch("/api/drives/:id/upload", upload.array("files"), (req, res) => {
    try {
        const { id } = req.params;
        const drives = getDrives();
        const driveIndex = drives.findIndex(d => d.id === id);

        if (driveIndex === -1) {
            return res.status(404).json({ error: "Drive not found" });
        }

        const uploadedFiles = req.files || [];
        const newImages = [];
        const newVideos = [];

        uploadedFiles.forEach(file => {
            const publicUrl = `http://localhost:${PORT}/uploads/${file.filename}`;
            const item = { id: file.filename, url: publicUrl, title: file.originalname };
            if (file.mimetype.startsWith("image/")) {
                item.type = "image";
                newImages.push(item);
            } else if (file.mimetype.startsWith("video/")) {
                item.type = "video";
                newVideos.push(item);
            }
        });

        drives[driveIndex].images = [...(drives[driveIndex].images || []), ...newImages];
        drives[driveIndex].videos = [...(drives[driveIndex].videos || []), ...newVideos];
        saveDrives(drives);

        res.json({ message: "Files added successfully", drive: drives[driveIndex] });
    } catch (error) {
        console.error("Add files error:", error);
        res.status(500).json({ error: "Failed to add files" });
    }
});

// Update drive settings
app.patch("/api/drives/:id/settings", (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        const drives = getDrives();
        const driveIndex = drives.findIndex(d => d.id === id);

        if (driveIndex === -1) {
            return res.status(404).json({ error: "Drive not found" });
        }

        // Update only allowed fields
        const allowedFields = [
            "clientName", "galleryType", "allowDownloads", "addWatermark", "coverColor", "coverAccent", "status", "favorites",
            "allowSelection", "favoritesName", "limitSelected", "allowComments",
            "requireEmail", "requirePhone", "requireInfo",
            "allowReviews", "reviewMessage", "askReviewAfterDownload",
            "showShareButton", "showBusinessCard", "showNameOnCover",
            "protectWithPassword", "password", "allowGuestAccess"
        ];
        allowedFields.forEach(field => {
            if (updates[field] !== undefined) {
                drives[driveIndex][field] = updates[field];
            }
        });

        // Update favoritesCount if favorites are provided
        if (updates.favorites !== undefined) {
            const totalMedia = (drives[driveIndex].images?.length || 0) + (drives[driveIndex].videos?.length || 0);
            drives[driveIndex].favoritesCount = `${updates.favorites.length}/${totalMedia}`;
        }

        saveDrives(drives);
        res.json({ message: "Settings updated successfully", drive: drives[driveIndex] });
    } catch (error) {
        console.error("Update settings error:", error);
        res.status(500).json({ error: "Failed to update settings" });
    }
});

// ----- SITE CUSTOMIZATION ROUTES -----

// GET site settings (public, no auth needed for public pages to read)
app.get("/api/site", (req, res) => {
    try {
        const settings = getSiteSettings();
        res.json(settings);
    } catch (error) {
        res.status(500).json({ error: "Failed to read site settings" });
    }
});

// POST site settings (save all + handle portfolio image uploads)
app.post("/api/site", upload.array("newPhotos"), (req, res) => {
    try {
        const settings = getSiteSettings();
        const allowedFields = ["theme", "accentColor", "photographerName", "tagline", "bio", "email", "phone", "location", "instagramUrl", "twitterUrl", "pinterestUrl"];

        allowedFields.forEach(field => {
            if (req.body[field] !== undefined) {
                settings[field] = req.body[field];
            }
        });

        // Handle removal of photos
        if (req.body.remainingPhotoIds) {
            const keepIds = JSON.parse(req.body.remainingPhotoIds);
            settings.portfolioPhotos = settings.portfolioPhotos.filter(p => keepIds.includes(p.id));
        }

        // Handle new uploaded photos
        if (req.files && req.files.length > 0) {
            req.files.forEach(file => {
                const publicUrl = `http://localhost:${PORT}/uploads/${file.filename}`;
                settings.portfolioPhotos.push({
                    id: file.filename,
                    url: publicUrl,
                    title: file.originalname.replace(/\.[^/.]+$/, "")
                });
            });
        }

        saveSiteSettings(settings);
        res.json({ message: "Site settings saved successfully", settings });
    } catch (error) {
        console.error("Save site settings error:", error);
        res.status(500).json({ error: "Failed to save site settings" });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Authentication & Storage Backend running on http://localhost:${PORT}`);
});
