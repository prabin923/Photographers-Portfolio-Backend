const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const multer = require("multer");
const { uploadToGCS, deleteFromGCS } = require("./storage");

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "wfolio_super_secret_key_123";

// Middleware
app.use(cors());
app.use(express.json());

// Expose the uploads directory publicly so the frontend can load the images/videos
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const DB_PATH = path.join(__dirname, "users.json");
const DATA_DIR = path.join(__dirname, "data");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ────────────────────────────────────────────────
//   Per-user data helpers
// ────────────────────────────────────────────────

function getUserDataDir(userId) {
    const dir = path.join(DATA_DIR, userId);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function getUserDrives(userId) {
    const filePath = path.join(getUserDataDir(userId), "drives.json");
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify([]));
        return [];
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveUserDrives(userId, drives) {
    const filePath = path.join(getUserDataDir(userId), "drives.json");
    fs.writeFileSync(filePath, JSON.stringify(drives, null, 2));
}

function getUserSiteSettings(userId) {
    const filePath = path.join(getUserDataDir(userId), "site.json");
    if (!fs.existsSync(filePath)) {
        const defaults = {
            theme: "dark", accentColor: "#3b82f6",
            photographerName: "", tagline: "Capturing timeless moments.",
            bio: "", email: "", phone: "", location: "",
            portfolioPhotos: [],
            instagramUrl: "#", twitterUrl: "#", pinterestUrl: "#"
        };
        fs.writeFileSync(filePath, JSON.stringify(defaults, null, 2));
        return defaults;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveUserSiteSettings(userId, settings) {
    const filePath = path.join(getUserDataDir(userId), "site.json");
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2));
}

// ────────────────────────────────────────────────
//   Plan / Pricing System
// ────────────────────────────────────────────────

const PLANS = {
    free: { id: "free", name: "Starter", storageLimitGB: 120, maxGalleries: -1, price: 0, period: "forever" },
    pro: { id: "pro", name: "Pro", storageLimitGB: 500, maxGalleries: -1, price: 12, period: "month" },
    business: { id: "business", name: "Business", storageLimitGB: 2000, maxGalleries: -1, price: 29, period: "month" },
};

function getUserPlan(userId) {
    const filePath = path.join(getUserDataDir(userId), "plan.json");
    if (!fs.existsSync(filePath)) {
        const defaultPlan = { planId: "free", activatedAt: new Date().toISOString(), expiresAt: null };
        fs.writeFileSync(filePath, JSON.stringify(defaultPlan, null, 2));
        return defaultPlan;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveUserPlan(userId, planData) {
    const filePath = path.join(getUserDataDir(userId), "plan.json");
    fs.writeFileSync(filePath, JSON.stringify(planData, null, 2));
}

// Calculate actual storage used by a user (from their drive files)
// Updated to use stored size if available, otherwise 0
function calculateUserStorage(userId) {
    const drives = getUserDrives(userId);
    const site = getUserSiteSettings(userId);
    let totalBytes = 0;

    for (const drive of drives) {
        const allMedia = [...(drive.images || []), ...(drive.videos || [])];
        for (const item of allMedia) {
            totalBytes += (item.size || 0);
        }
    }

    for (const photo of (site.portfolioPhotos || [])) {
        totalBytes += (photo.size || 0);
    }

    return totalBytes;
}

// ────────────────────────────────────────────────
//   Legacy shared data helpers (for migration)
// ────────────────────────────────────────────────

const LEGACY_DRIVE_DB = path.join(__dirname, "drives.json");
const LEGACY_SITE_DB = path.join(__dirname, "site.json");

// Migrate legacy data to the first user (one-time)
function migrateLegacyData() {
    const users = getUsers();
    if (users.length === 0) return;

    const firstUser = users[0];
    const userDir = getUserDataDir(firstUser.id);
    const userDrivesPath = path.join(userDir, "drives.json");
    const userSitePath = path.join(userDir, "site.json");

    // Migrate drives.json if legacy exists and user doesn't have drives yet
    if (fs.existsSync(LEGACY_DRIVE_DB) && !fs.existsSync(userDrivesPath)) {
        const legacyDrives = JSON.parse(fs.readFileSync(LEGACY_DRIVE_DB, "utf8"));
        // Tag each drive with userId
        const taggedDrives = legacyDrives.map(d => ({ ...d, userId: firstUser.id }));
        fs.writeFileSync(userDrivesPath, JSON.stringify(taggedDrives, null, 2));
        console.log(`✅ Migrated ${legacyDrives.length} drives to user ${firstUser.id}`);
    }

    // Migrate site.json
    if (fs.existsSync(LEGACY_SITE_DB) && !fs.existsSync(userSitePath)) {
        const legacySite = JSON.parse(fs.readFileSync(LEGACY_SITE_DB, "utf8"));
        fs.writeFileSync(userSitePath, JSON.stringify(legacySite, null, 2));
        console.log(`✅ Migrated site settings to user ${firstUser.id}`);
    }
}

// Define Multer storage configuration - use memory for GCS uploads
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB limit
    }
});

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

// ────────────────────────────────────────────────
//   Auth middleware — extracts user from JWT
// ────────────────────────────────────────────────

function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Authentication required" });
    }
    const token = authHeader.split(" ")[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; // { id, email, name }
        next();
    } catch (error) {
        return res.status(401).json({ error: "Invalid or expired token" });
    }
}

// ────────────────────────────────────────────────
//   AUTHENTICATION ROUTES
// ────────────────────────────────────────────────

app.post("/api/auth/register", async (req, res) => {
    console.log("POST /api/auth/register body:", req.body);
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: "All fields are required" });
        }

        const users = getUsers();
        if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
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

        // Create default data directory for the new user
        getUserDataDir(newUser.id);

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
        const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());

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

// ────────────────────────────────────────────────
//   PLAN / STORAGE ROUTES
// ────────────────────────────────────────────────

// Get all available plans (public — for pricing page)
app.get("/api/plans", (req, res) => {
    res.json({ plans: Object.values(PLANS) });
});

// Get current user's plan + storage usage (protected)
app.get("/api/plan", authMiddleware, (req, res) => {
    try {
        const userPlan = getUserPlan(req.user.id);
        const planDetails = PLANS[userPlan.planId] || PLANS.free;
        const storageUsedBytes = calculateUserStorage(req.user.id);
        const drives = getUserDrives(req.user.id);

        res.json({
            plan: {
                ...planDetails,
                activatedAt: userPlan.activatedAt,
                expiresAt: userPlan.expiresAt,
            },
            storage: {
                usedBytes: storageUsedBytes,
                usedGB: +(storageUsedBytes / (1024 * 1024 * 1024)).toFixed(2),
                limitGB: planDetails.storageLimitGB,
                percentUsed: +((storageUsedBytes / (planDetails.storageLimitGB * 1024 * 1024 * 1024)) * 100).toFixed(1),
            },
            galleries: {
                count: drives.length,
                limit: planDetails.maxGalleries,
            },
        });
    } catch (error) {
        console.error("Get plan error:", error);
        res.status(500).json({ error: "Failed to get plan info" });
    }
});

// Upgrade / change plan (protected)
app.post("/api/plan/upgrade", authMiddleware, (req, res) => {
    try {
        const { planId } = req.body;
        if (!PLANS[planId]) {
            return res.status(400).json({ error: "Invalid plan ID. Choose: free, pro, or business" });
        }

        const now = new Date();
        const expiresAt = planId === "free" ? null : new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()).toISOString();

        const planData = {
            planId,
            activatedAt: now.toISOString(),
            expiresAt,
        };
        saveUserPlan(req.user.id, planData);

        const planDetails = PLANS[planId];
        res.json({
            message: `Successfully ${planId === "free" ? "downgraded to" : "upgraded to"} ${planDetails.name} plan!`,
            plan: { ...planDetails, ...planData },
        });
    } catch (error) {
        console.error("Upgrade plan error:", error);
        res.status(500).json({ error: "Failed to upgrade plan" });
    }
});

// ────────────────────────────────────────────────
//   PUBLIC ROUTES (client/portfolio pages)
//   Uses userId query param to load the right user's data
// ────────────────────────────────────────────────

// Get all users (public list for portfolio URLs)
app.get("/api/users/list", (req, res) => {
    const users = getUsers();
    res.json({
        users: users.map(u => ({
            id: u.id,
            name: u.name
        }))
    });
});

// Public: get site settings for a specific user
app.get("/api/site", (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) {
            // Try to extract from auth header if present
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith("Bearer ")) {
                try {
                    const decoded = jwt.verify(authHeader.split(" ")[1], JWT_SECRET);
                    const settings = getUserSiteSettings(decoded.id);
                    return res.json(settings);
                } catch { }
            }
            // Fallback: return first user's settings if no userId specified
            const users = getUsers();
            if (users.length > 0) {
                return res.json(getUserSiteSettings(users[0].id));
            }
            return res.json({});
        }
        const settings = getUserSiteSettings(userId);
        res.json(settings);
    } catch (error) {
        res.status(500).json({ error: "Failed to read site settings" });
    }
});

// Public: get a specific drive by ID (for client gallery page)
app.get("/api/drive/client/:driveId", (req, res) => {
    try {
        const driveId = req.params.driveId;
        // Search through all users' drives to find the matching drive
        const users = getUsers();
        for (const user of users) {
            const drives = getUserDrives(user.id);
            const targetDrive = drives.find(d => d.id === driveId);
            if (targetDrive) {
                return res.json({
                    ...targetDrive,
                    folderId: targetDrive.id,
                    totalCount: (targetDrive.images?.length || 0) + (targetDrive.videos?.length || 0),
                    userId: user.id
                });
            }
        }
        return res.status(404).json({ error: "Drive not found" });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch drive files" });
    }
});

// Public: list all drives (for public client page — shows drives of a specific user)
app.get("/api/drives/public", (req, res) => {
    const { userId } = req.query;
    if (!userId) {
        // Fallback: first user
        const users = getUsers();
        if (users.length > 0) {
            return res.json({ drives: getUserDrives(users[0].id) });
        }
        return res.json({ drives: [] });
    }
    res.json({ drives: getUserDrives(userId) });
});

// ────────────────────────────────────────────────
//   PROTECTED ROUTES (admin — scoped to logged-in user)
// ────────────────────────────────────────────────

// Get drives for the logged-in user
app.get("/api/drives", authMiddleware, (req, res) => {
    const drives = getUserDrives(req.user.id);
    res.json({ drives });
});

// Create a new drive for the logged-in user
app.post("/api/drives", authMiddleware, upload.array("files"), async (req, res) => {
    try {
        const { clientName } = req.body;
        if (!clientName) {
            return res.status(400).json({ error: "clientName is required" });
        }

        // Check plan limits
        const userPlan = getUserPlan(req.user.id);
        const planDetails = PLANS[userPlan.planId] || PLANS.free;
        const currentDrives = getUserDrives(req.user.id);

        if (planDetails.maxGalleries !== -1 && currentDrives.length >= planDetails.maxGalleries) {
            return res.status(403).json({ error: `Gallery limit reached. Your ${planDetails.name} plan allows only ${planDetails.maxGalleries} galleries. Please upgrade to create more.` });
        }

        // Check storage limit pre-upload (rough check)
        const storageLimitBytes = planDetails.storageLimitGB * 1024 * 1024 * 1024;
        const currentUsageBytes = calculateUserStorage(req.user.id);
        const newFilesSize = (req.files || []).reduce((sum, f) => sum + f.size, 0);

        if (currentUsageBytes + newFilesSize > storageLimitBytes) {
            return res.status(403).json({ error: "Storage limit reached. Please upgrade your plan to upload more photos." });
        }

        const driveId = Date.now().toString();
        const uploadedFiles = req.files || [];
        const images = [];
        const videos = [];

        for (const file of uploadedFiles) {
            const gcsResult = await uploadToGCS(file);
            const item = { 
                id: gcsResult.id, 
                url: gcsResult.url, 
                title: file.originalname,
                type: gcsResult.type,
                size: file.size
            };
            if (item.type === 'image') images.push(item);
            else videos.push(item);
        }

        const newDrive = {
            id: driveId,
            userId: req.user.id,
            clientName,
            images,
            videos,
            status: "Active",
            favoritesCount: "0/0",
            createdAt: new Date().toLocaleDateString("en-US", { month: 'short', day: 'numeric', year: 'numeric' })
        };

        const drives = getUserDrives(req.user.id);
        drives.push(newDrive);
        saveUserDrives(req.user.id, drives);

        res.status(201).json({ message: "Drive created successfully", drive: newDrive });
    } catch (error) {
        console.error("Upload error:", error);
        res.status(500).json({ error: "Failed to create drive" });
    }
});

// Delete a drive
app.delete("/api/drives/:id", authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const drives = getUserDrives(req.user.id);
        const drive = drives.find(d => d.id === id);

        if (!drive) {
            return res.status(404).json({ error: "Drive not found" });
        }

        // Clean up GCS files
        const allMedia = [...(drive.images || []), ...(drive.videos || [])];
        for (const item of allMedia) {
            await deleteFromGCS(item.id);
        }

        const newDrives = drives.filter(d => d.id !== id);
        saveUserDrives(req.user.id, newDrives);

        res.json({ message: "Drive deleted successfully" });
    } catch (error) {
        console.error("Delete drive error:", error);
        res.status(500).json({ error: "Failed to delete drive" });
    }
});

// Add more files to an existing drive
app.patch("/api/drives/:id/upload", authMiddleware, upload.array("files"), async (req, res) => {
    try {
        const { id } = req.params;
        const drives = getUserDrives(req.user.id);
        const driveIndex = drives.findIndex(d => d.id === id);

        if (driveIndex === -1) {
            return res.status(404).json({ error: "Drive not found" });
        }

        // Check storage limit
        const userPlan = getUserPlan(req.user.id);
        const planDetails = PLANS[userPlan.planId] || PLANS.free;
        const storageLimitBytes = planDetails.storageLimitGB * 1024 * 1024 * 1024;
        const currentUsageBytes = calculateUserStorage(req.user.id);
        const newFilesSize = (req.files || []).reduce((sum, f) => sum + f.size, 0);

        if (currentUsageBytes + newFilesSize > storageLimitBytes) {
            return res.status(403).json({ error: "Storage limit reached. Please upgrade your plan to upload more photos." });
        }

        const uploadedFiles = req.files || [];
        const newImages = [];
        const newVideos = [];

        for (const file of uploadedFiles) {
            const gcsResult = await uploadToGCS(file);
            const item = { 
                id: gcsResult.id, 
                url: gcsResult.url, 
                title: file.originalname,
                type: gcsResult.type,
                size: file.size
            };
            if (item.type === "image") newImages.push(item);
            else newVideos.push(item);
        }

        drives[driveIndex].images = [...(drives[driveIndex].images || []), ...newImages];
        drives[driveIndex].videos = [...(drives[driveIndex].videos || []), ...newVideos];
        saveUserDrives(req.user.id, drives);

        res.json({ message: "Files added successfully", drive: drives[driveIndex] });
    } catch (error) {
        console.error("Add files error:", error);
        res.status(500).json({ error: "Failed to add files" });
    }
});

// Update drive settings (public route for client favorites - no auth)
app.patch("/api/drives/:id/settings", (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        // Find the drive across all users
        const users = getUsers();
        for (const user of users) {
            const drives = getUserDrives(user.id);
            const driveIndex = drives.findIndex(d => d.id === id);
            if (driveIndex !== -1) {
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

                if (updates.favorites !== undefined) {
                    const totalMedia = (drives[driveIndex].images?.length || 0) + (drives[driveIndex].videos?.length || 0);
                    drives[driveIndex].favoritesCount = `${updates.favorites.length}/${totalMedia}`;
                }

                saveUserDrives(user.id, drives);
                return res.json({ message: "Settings updated successfully", drive: drives[driveIndex] });
            }
        }
        return res.status(404).json({ error: "Drive not found" });
    } catch (error) {
        console.error("Update settings error:", error);
        res.status(500).json({ error: "Failed to update settings" });
    }
});

// ────────────────────────────────────────────────
//   SITE CUSTOMIZATION (protected — per user)
// ────────────────────────────────────────────────

app.post("/api/site", authMiddleware, upload.array("newPhotos"), async (req, res) => {
    try {
        // Check storage limit
        const userPlan = getUserPlan(req.user.id);
        const planDetails = PLANS[userPlan.planId] || PLANS.free;
        const storageLimitBytes = planDetails.storageLimitGB * 1024 * 1024 * 1024;
        const currentUsageBytes = calculateUserStorage(req.user.id);
        const newFilesSize = (req.files || []).reduce((sum, f) => sum + f.size, 0);

        if (currentUsageBytes + newFilesSize > storageLimitBytes) {
            return res.status(403).json({ error: "Storage limit reached. Please upgrade your plan to upload more photos." });
        }

        const settings = getUserSiteSettings(req.user.id);
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
            for (const file of req.files) {
                const gcsResult = await uploadToGCS(file);
                settings.portfolioPhotos.push({
                    id: gcsResult.id,
                    url: gcsResult.url,
                    title: file.originalname.replace(/\.[^/.]+$/, ""),
                    size: file.size
                });
            }
        }

        saveUserSiteSettings(req.user.id, settings);
        res.json({ message: "Site settings saved successfully", settings });
    } catch (error) {
        console.error("Save site settings error:", error);
        res.status(500).json({ error: "Failed to save site settings" });
    }
});

// ────────────────────────────────────────────────
//   START SERVER
// ────────────────────────────────────────────────

// Run migration on startup
migrateLegacyData();

app.listen(PORT, () => {
    console.log(`🚀 Authentication & Storage Backend running on http://localhost:${PORT}`);
});
