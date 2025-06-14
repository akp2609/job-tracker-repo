import User from "../models/User.js";
import { basename, parse } from "path";
import { uploadToGCS, deleteFromGCS } from "../utils/gcsUploader.js";
import { getDbByName } from "../config/db.js";


const bucketName = process.env.GOOGLE_BUCKET_NAME;


export const uploadResume = async (req, res) => {

    try {

        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const user = await User.findById(req.user._id);

        if (!user) return res.status(404).json({ message: 'User not found' });

        if (user.resumeURL) {
            try {

                const url = new URL(user.resumeURL);

                await deleteFromGCS(user.objectName);
                console.log('Previous resume deleted');

            } catch (err) {
                console.error('Failed to delete previous resume: ', err.message);
                return res.status(404).json({ message: err.message });
            }
        }

        const localPath = req.file.path;
        const originalName = req.file.originalname;

        const publicUrl = await uploadToGCS(localPath, originalName, user._id);

        user.resumeURL = publicUrl.signedUrl;
        const url = new URL(publicUrl.signedUrl);
        const objectNameCur = `${user._id}/${decodeURIComponent(url.pathname.split('/').pop())}`;
        user.objectName = objectNameCur;

        await user.save();

        console.log('User updated:', user);

        res.status(200).json({
            message: "Resume uploaded successfully",
            resumeURL: publicUrl,
            objectName: objectNameCur,
            user
        });

    } catch (err) {
        console.error({ message: 'Resume upload failed', err });
        res.status(500).json({
            message: "Upload failed",
            error: err.message || "Unknown error"
        });
    }
};

export const deleteResume = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);

        if (!user || !user.resumeURL || !user.objectName) {
            return res.status(400).json({ message: "No resume found to delete" });
        }

        await deleteFromGCS(user.objectName);

        user.resumeURL = undefined;
        user.objectName = undefined;
        await user.save();

        res.status(200).json({ message: "Resume deleted successfully" });
    } catch (err) {
        console.error('Failed to delete resume', err.message);
        res.status(500).json({ message: "Resume deletion failed" });
    }
}

export const uploadProfilePic = async (req, res) => {
    try {
        const user = await User.findByIdAndUpdate(
            req.user._id,
            { profilePicture: req.file.path },
            { new: true }
        );
        res.json({ message: 'Profile picture uploaded', url: user.profilePicture })
    } catch (err) {
        res.status(500).json({ error: 'Something went wrong' });
    }
}

export const saveJobs = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const jobId = req.params.jobId;

        if (user.savedJobs.includes(jobId)) {
            return res.status(400).json({ message: 'Job already saved' });
        }

        user.savedJobs = [...user.savedJobs, jobId];

        await user.save();

        return res.status(200).json({ message: 'job saved' });

    } catch (err) {
        console.error('Job saving failed', err);
        return res.status(500).json({ message: 'Job saving failed' });
    }
}

export const getSavedJobs = async (req, res) => {
    try {

        const savedJobs = await User.findById(req.user._id).select('savedJobs').populate('savedJobs');

        if (!savedJobs) {
            return res.status(404).json({ message: 'User not found' });
        }

        res.status(200).json(savedJobs);

    } catch (err) {
        console.error('Failed to fetch saved jobs', err);
        return res.status(500).json({ message: 'Failed to get saved jobs' });
    }
}

export const deleteSavedJobs = async (req, res) => {
}

function averageEmbedding(embeddings) {
    const length = embeddings.length;
    const summed = embeddings.reduce((acc, vector) =>
        acc.map((val, i) => val + vector[i])
    );

    return summed.map(val => val / length);
}

export const relevantJobs = async (req, res) => {
    try {

        const userId = req.user._id.toString();

        const resumeDb = getDbByName("resumeAnalyzerDB");
        console.log("✅ Connected to resumeDB");
        const resumeDoc = await resumeDb.collection("resumes").findOne({ userId });

        if (!resumeDoc || !resumeDoc.embeddings) {
            console.warn("⚠️ Resume embedding not found for userId:", userId);
            return res.status(404).json({ message: "Resume embeddings not found" });
        }

        const resumeVector = averageEmbedding(resumeDoc.embeddings);

        const jobDb = getDbByName("hireBizzProd");
        const jobResults = await jobDb.collection("jobs").aggregate([
            {
                $vectorSearch: {
                    queryVector: resumeVector,
                    path: "embeddings",
                    numCandidates: 100,
                    limit: 10,
                    index: "jobsIndex"
                }
            }, {
                $project: {
                    _id: 1,
                    title: 1,
                    location: 1,
                    skills: 1,
                    company: 1,
                    relevancy: {
                        $multiply: [{ $meta: "vectorSearchScore" }, 100]
                    }
                }
            }
        ]).toArray();

      

        return res.status(200).json({ success: true, relevantJobs: jobResults });

    } catch (err) {
        console.error("Vector search failed:", err);
        return res.status(500).json({ message: "Internal server error", error: err.message });
    }
}