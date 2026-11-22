const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ObjectId } = require("mongodb");

// Firebase Admin modular API
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// =====================================
// FIREBASE ADMIN INITIALIZATION
// =====================================

let firebaseAdminReady = false;

try {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is missing from .env");
  }

  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  if (!getApps().length) {
    initializeApp({
      credential: cert(serviceAccount),
    });
  }

  firebaseAdminReady = true;
  console.log("Firebase Admin initialized successfully!");
} catch (error) {
  console.error("Firebase Admin initialization failed:", error.message);
}

// =====================================
// VERIFY FIREBASE USER
// =====================================

const verifyFirebaseUser = async (req, res, next) => {
  if (!firebaseAdminReady) {
    return res.status(503).send({
      message:
        "Server authentication is not configured. Check FIREBASE_SERVICE_ACCOUNT.",
    });
  }

  const token = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : null;

  if (!token) {
    return res.status(401).send({
      message: "Authentication token required",
    });
  }

  try {
    req.firebaseUser = await getAuth().verifyIdToken(token);
    next();
  } catch (error) {
    console.error("Token verification failed:", error.message);

    return res.status(401).send({
      message: "Invalid or expired authentication token",
    });
  }
};

// =====================================
// MONGODB CONNECTION
// =====================================

const client = new MongoClient(
  `mongodb+srv://${process.env.DB_User}:${process.env.DB_Password}@cluster0.h7jwv.mongodb.net/?appName=Cluster0`,
);

async function connectToMongoDB() {
  try {
    await client.connect();

    console.log("You successfully connected to MongoDB!");

    const database = client.db("jobPortal");

    const jobsCollection = database.collection("jobs");
    const applicationsCollection = database.collection("applications");
    const usersCollection = database.collection("users");

    // =====================================
    // ROLE MIDDLEWARE
    // =====================================

    const requireRole =
      (...roles) =>
      async (req, res, next) => {
        try {
          const email = req.firebaseUser?.email?.toLowerCase();

          if (!email) {
            return res.status(401).send({
              message: "Authenticated email is missing",
            });
          }

          const account = await usersCollection.findOne({ email });

          if (!account || !roles.includes(account.role)) {
            return res.status(403).send({
              message: "You do not have permission to perform this action",
            });
          }

          req.account = account;
          next();
        } catch (error) {
          console.error(error);

          res.status(500).send({
            message: "Could not verify account role",
          });
        }
      };

    // =====================================
    // REGISTER USER
    // =====================================

    app.post("/users/register", verifyFirebaseUser, async (req, res) => {
      try {
        const email = req.firebaseUser.email?.toLowerCase();

        if (!email || email !== req.body.email?.trim().toLowerCase()) {
          return res.status(403).send({
            message: "Account email does not match token",
          });
        }

        const adminEmails = (process.env.ADMIN_EMAILS || "")
          .split(",")
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean);

        const isAdmin = adminEmails.includes(email);

        // Avoid MongoDB update conflict.
        // Existing HR roles are preserved for normal users.

        const userUpdate = {
          $setOnInsert: {
            email,
            name: req.body.name || "",
            createdAt: new Date(),
          },
        };

        if (isAdmin) {
          userUpdate.$set = {
            role: "admin",
          };
        } else {
          userUpdate.$setOnInsert.role = "applicant";
        }

        await usersCollection.updateOne({ email }, userUpdate, {
          upsert: true,
        });

        const account = await usersCollection.findOne(
          { email },
          {
            projection: {
              name: 1,
              email: 1,
              role: 1,
            },
          },
        );

        res.send(account);
      } catch (error) {
        console.error(error);

        res.status(500).send({
          message: "Could not register account",
        });
      }
    });

    // =====================================
    // ADMIN: GET ALL USERS
    // =====================================

    app.get(
      "/admin/users",
      verifyFirebaseUser,
      requireRole("admin"),
      async (req, res) => {
        try {
          const users = await usersCollection
            .find(
              {},
              {
                projection: {
                  name: 1,
                  email: 1,
                  role: 1,
                  createdAt: 1,
                },
              },
            )
            .sort({ createdAt: -1 })
            .toArray();

          res.send(users);
        } catch (error) {
          console.error(error);

          res.status(500).send({
            message: "Failed to fetch users",
          });
        }
      },
    );

    // =====================================
    // ADMIN: UPDATE USER ROLE
    // =====================================

    app.patch(
      "/admin/users/:id/role",
      verifyFirebaseUser,
      requireRole("admin"),
      async (req, res) => {
        try {
          const { role } = req.body;

          if (!["admin", "HR", "applicant"].includes(role)) {
            return res.status(400).send({
              message: "Role must be admin, HR, or applicant",
            });
          }

          if (!ObjectId.isValid(req.params.id)) {
            return res.status(400).send({
              message: "Invalid user ID",
            });
          }

          const target = await usersCollection.findOne({
            _id: new ObjectId(req.params.id),
          });

          if (!target) {
            return res.status(404).send({
              message: "User not found",
            });
          }

          if (target.email === req.account.email && role !== "admin") {
            return res.status(400).send({
              message: "You cannot remove your own admin role",
            });
          }

          await usersCollection.updateOne(
            { _id: target._id },
            {
              $set: {
                role,
                updatedAt: new Date(),
              },
            },
          );

          res.send({
            success: true,
            role,
          });
        } catch (error) {
          console.error(error);

          res.status(500).send({
            message: "Could not update user role",
          });
        }
      },
    );

    const isValidId = (id) => ObjectId.isValid(id);

    // =====================================
    // ADD JOB
    // =====================================

    app.post(
      "/jobs",
      verifyFirebaseUser,
      requireRole("HR", "admin"),
      async (req, res) => {
        try {
          const { title, company } = req.body;
          const postedByEmail = req.firebaseUser.email;

          if (!title?.trim() || !company?.trim() || !postedByEmail?.trim()) {
            return res.status(400).send({
              message: "Title, company, and HR email are required",
            });
          }

          const job = {
            ...req.body,
            title: title.trim(),
            company: company.trim(),
            postedByEmail: postedByEmail.trim().toLowerCase(),
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          const result = await jobsCollection.insertOne(job);

          res.status(201).send({
            success: true,
            insertedId: result.insertedId,
          });
        } catch (error) {
          console.error(error);

          res.status(500).send({
            message: "Failed to create job",
          });
        }
      },
    );

    // =====================================
    // GET MY POSTED JOBS
    // =====================================

    app.get(
      "/my-jobs",
      verifyFirebaseUser,
      requireRole("HR ", "admin"),
      async (req, res) => {
        try {
          const email = req.firebaseUser.email.toLowerCase();

          const jobs = await jobsCollection
            .find({ postedByEmail: email })
            .sort({ createdAt: -1 })
            .toArray();

          res.send(jobs);
        } catch (error) {
          console.error(error);

          res.status(500).send({
            message: "Failed to fetch posted jobs",
          });
        }
      },
    );

    // =====================================
    // GET ALL JOBS
    // =====================================

    app.get("/jobs", async (req, res) => {
      try {
        const jobs = await jobsCollection
          .find()
          .sort({ createdAt: -1 })
          .toArray();

        res.send(jobs);
      } catch (error) {
        console.error(error);

        res.status(500).send({
          message: "Failed to fetch jobs",
        });
      }
    });

    // =====================================
    // GET SINGLE JOB
    // =====================================

    app.get("/jobs/:id", async (req, res) => {
      try {
        if (!isValidId(req.params.id)) {
          return res.status(400).send({
            message: "Invalid job ID",
          });
        }

        const job = await jobsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });

        if (!job) {
          return res.status(404).send({
            message: "Job not found",
          });
        }

        res.send(job);
      } catch (error) {
        console.error(error);

        res.status(500).send({
          message: "Failed to fetch job",
        });
      }
    });

    // =====================================
    // UPDATE JOB
    // =====================================

    app.patch(
      "/jobs/:id",
      verifyFirebaseUser,
      requireRole("hr", "admin"),
      async (req, res) => {
        try {
          const updates = req.body;
          const ownerEmail = req.firebaseUser.email;

          if (!isValidId(req.params.id)) {
            return res.status(400).send({
              message: "Invalid job ID",
            });
          }

          if (!ownerEmail) {
            return res.status(400).send({
              message: "Owner email is required",
            });
          }

          const allowedFields = [
            "title",
            "company",
            "companyLogo",
            "location",
            "jobType",
            "salary",
            "deadline",
            "category",
            "description",
          ];

          const fieldsToUpdate = {};

          allowedFields.forEach((field) => {
            if (updates[field] !== undefined) {
              fieldsToUpdate[field] = updates[field];
            }
          });

          fieldsToUpdate.updatedAt = new Date();

          const result = await jobsCollection.updateOne(
            {
              _id: new ObjectId(req.params.id),
              postedByEmail: ownerEmail.trim().toLowerCase(),
            },
            {
              $set: fieldsToUpdate,
            },
          );

          if (!result.matchedCount) {
            return res.status(404).send({
              message: "Job not found or you do not own this job",
            });
          }

          res.send({
            success: true,
            message: "Job updated successfully",
          });
        } catch (error) {
          console.error(error);

          res.status(500).send({
            message: "Failed to update job",
          });
        }
      },
    );

    // =====================================
    // DELETE JOB
    // =====================================

    app.delete(
      "/jobs/:id",
      verifyFirebaseUser,
      requireRole("hr", "admin"),
      async (req, res) => {
        try {
          const email = req.firebaseUser.email.toLowerCase();

          if (!isValidId(req.params.id)) {
            return res.status(400).send({
              message: "Valid job ID and email required",
            });
          }

          const result = await jobsCollection.deleteOne({
            _id: new ObjectId(req.params.id),
            postedByEmail: email,
          });

          if (!result.deletedCount) {
            return res.status(404).send({
              message: "Job not found or you do not own this job",
            });
          }

          // Delete applications belonging to this job.
          await applicationsCollection.deleteMany({
            jobId: req.params.id,
          });

          res.send({
            success: true,
            message: "Job and its applications deleted",
          });
        } catch (error) {
          console.error(error);

          res.status(500).send({
            message: "Failed to delete job",
          });
        }
      },
    );

    // =====================================
    // GET APPLICANTS FOR A JOB
    // =====================================

    app.get(
      "/jobs/:id/applications",
      verifyFirebaseUser,
      requireRole("hr", "admin"),
      async (req, res) => {
        try {
          const email = req.firebaseUser.email.toLowerCase();

          if (!isValidId(req.params.id)) {
            return res.status(400).send({
              message: "Valid job ID and email required",
            });
          }

          const job = await jobsCollection.findOne({
            _id: new ObjectId(req.params.id),
            postedByEmail: email,
          });

          if (!job) {
            return res.status(404).send({
              message: "Job not found or you do not own this job",
            });
          }

          const applications = await applicationsCollection
            .find({ jobId: req.params.id })
            .sort({ appliedAt: -1 })
            .toArray();

          res.send(applications);
        } catch (error) {
          console.error(error);

          res.status(500).send({
            message: "Failed to fetch applicants",
          });
        }
      },
    );

    // =====================================
    // UPDATE APPLICATION STATUS
    // =====================================

    app.patch(
      "/applications/:id/status",
      verifyFirebaseUser,
      requireRole("hr", "admin"),
      async (req, res) => {
        try {
          const { status } = req.body;
          const ownerEmail = req.firebaseUser.email;

          const allowedStatuses = ["Pending", "Accept", "Reject", "Hire"];

          if (!ObjectId.isValid(req.params.id)) {
            return res.status(400).send({
              message: "Invalid application ID",
            });
          }

          if (!ownerEmail || !allowedStatuses.includes(status)) {
            return res.status(400).send({
              message: "Owner email and a valid status are required",
            });
          }

          const application = await applicationsCollection.findOne({
            _id: new ObjectId(req.params.id),
          });

          if (!application) {
            return res.status(404).send({
              message: "Application not found",
            });
          }

          if (!ObjectId.isValid(application.jobId)) {
            return res.status(400).send({
              message: "Invalid job ID in application",
            });
          }

          // Verify that this HR owns the job.
          const job = await jobsCollection.findOne({
            _id: new ObjectId(application.jobId),
            postedByEmail: ownerEmail.trim().toLowerCase(),
          });

          if (!job) {
            return res.status(403).send({
              message: "You cannot update this applicant's status",
            });
          }

          const result = await applicationsCollection.updateOne(
            {
              _id: new ObjectId(req.params.id),
            },
            {
              $set: {
                status,
                reviewedAt: new Date(),
              },
            },
          );

          if (!result.matchedCount) {
            return res.status(404).send({
              message: "Application not found",
            });
          }

          res.send({
            success: true,
            message: "Applicant status updated successfully",
            status,
          });
        } catch (error) {
          console.error(error);

          res.status(500).send({
            message: "Failed to update applicant status",
          });
        }
      },
    );

    // =====================================
    // APPLY FOR A JOB
    // =====================================

    app.post(
      "/applications",
      verifyFirebaseUser,
      requireRole("applicant"),
      async (req, res) => {
        try {
          const application = {
            ...req.body,
            applicantEmail: req.firebaseUser.email.toLowerCase(),
            status: "Pending",
            appliedAt: new Date(),
          };

          const result = await applicationsCollection.insertOne(application);

          res.status(201).send(result);
        } catch (error) {
          console.error(error);

          res.status(500).send({
            message: "Failed to submit application",
          });
        }
      },
    );

    // =====================================
    // GET MY APPLICATIONS
    // =====================================

    app.get(
      "/applications",
      verifyFirebaseUser,
      requireRole("applicant"),
      async (req, res) => {
        try {
          const email = req.firebaseUser.email.toLowerCase();

          const applications = await applicationsCollection
            .find({ applicantEmail: email })
            .sort({ appliedAt: -1 })
            .toArray();

          res.send(applications);
        } catch (error) {
          console.error(error);

          res.status(500).send({
            message: "Failed to fetch applications",
          });
        }
      },
    );

    return client;
  } catch (error) {
    console.error("MongoDB connection error:", error);
  }
}

// Connect MongoDB
connectToMongoDB();

// =====================================
// ROOT ROUTE
// =====================================

app.get("/", (req, res) => {
  res.send("Welcome to Job Seeker BD Server");
});

// =====================================
// START SERVER
// =====================================

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
