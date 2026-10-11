const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ObjectId } = require("mongodb");
const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// DB connection

const client = new MongoClient(
  `mongodb+srv://${process.env.DB_User}:${process.env.DB_Password}@cluster0.h7jwv.mongodb.net/?appName=Cluster0`,
);

async function connectToMongoDB() {
  try {
    console.log("You successfully connected to MongoDB!");
    // All Jobs Api
    const jobsCollection = client.db("jobPortal").collection("jobs");
    const applicationsCollection = client
      .db("jobPortal")
      .collection("applications");
    const isValidId = (id) => ObjectId.isValid(id);

    //Add a job
    app.post("/jobs", async (req, res) => {
      try {
        const { title, company, postedByEmail } = req.body;

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
        res.status(201).send({ success: true, insertedId: result.insertedId });
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to create job" });
      }
    });

    // Get all jobs posted by one HR/Admin
    app.get("/my-jobs", async (req, res) => {
      try {
        const email = req.query.email?.trim().toLowerCase();

        if (!email) {
          return res.status(400).send({ message: "HR email is required" });
        }

        const jobs = await jobsCollection
          .find({ postedByEmail: email })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(jobs);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to fetch posted jobs" });
      }
    });

    app.get("/jobs", async (req, res) => {
      try {
        const jobs = await jobsCollection
          .find()
          .sort({ createdAt: -1 })
          .toArray();
        res.send(jobs);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to fetch jobs" });
      }
    });

    //Get one job
    app.get("/jobs/:id", async (req, res) => {
      try {
        if (!isValidId(req.params.id)) {
          return res.status(400).send({ message: "Invalid job ID" });
        }

        const job = await jobsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });

        if (!job) {
          return res.status(404).send({ message: "Job not found" });
        }

        res.send(job);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to fetch job" });
      }
    });

    // Update a job (only the matching owner email is accepted here)
    app.patch("/jobs/:id", async (req, res) => {
      try {
        const { ownerEmail, ...updates } = req.body;

        if (!isValidId(req.params.id)) {
          return res.status(400).send({ message: "Invalid job ID" });
        }

        if (!ownerEmail) {
          return res.status(400).send({ message: "Owner email is required" });
        }

        // Only allow these job fields to be changed
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
          { $set: fieldsToUpdate },
        );

        if (!result.matchedCount) {
          return res.status(404).send({
            message: "Job not found or you do not own this job",
          });
        }

        res.send({ success: true, message: "Job updated successfully" });
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to update job" });
      }
    });

    // Delete a job (only the matching owner email is accepted here)
    app.delete("/jobs/:id", async (req, res) => {
      try {
        const email = req.query.email?.trim().toLowerCase();

        if (!isValidId(req.params.id) || !email) {
          return res
            .status(400)
            .send({ message: "Valid job ID and email required" });
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

        // Remove applications for this job too
        await applicationsCollection.deleteMany({ jobId: req.params.id });

        res.send({
          success: true,
          message: "Job and its applications deleted",
        });
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to delete job" });
      }
    });

    // Get applicants for a job owned by this HR/Admin
    app.get("/jobs/:id/applications", async (req, res) => {
      try {
        const email = req.query.email?.trim().toLowerCase();

        if (!isValidId(req.params.id) || !email) {
          return res
            .status(400)
            .send({ message: "Valid job ID and email required" });
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
        res.status(500).send({ message: "Failed to fetch applicants" });
      }
    });

    //  Review an application: Pending -> Accept / Reject / Hire
    app.patch("/applications/:id/status", async (req, res) => {
      try {
        const { status, ownerEmail } = req.body;
        const allowedStatuses = ["Pending", "Accept", "Reject", "Hire"];

        if (!ObjectId.isValid(req.params.id)) {
          return res.status(400).send({ message: "Invalid application ID" });
        }

        if (!ownerEmail || !allowedStatuses.includes(status)) {
          return res.status(400).send({
            message: "Owner email and a valid status are required",
          });
        }

        // Find the application
        const application = await applicationsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });

        if (!application) {
          return res.status(404).send({ message: "Application not found" });
        }

        if (!ObjectId.isValid(application.jobId)) {
          return res
            .status(400)
            .send({ message: "Invalid job ID in application" });
        }

        // Verify that this HR owns the job
        const job = await jobsCollection.findOne({
          _id: new ObjectId(application.jobId),
          postedByEmail: ownerEmail.trim().toLowerCase(),
        });

        if (!job) {
          return res.status(403).send({
            message: "You cannot update this applicant's status",
          });
        }

        // Update the applications collection
        const result = await applicationsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          {
            $set: {
              status,
              reviewedAt: new Date(),
            },
          },
        );

        if (!result.matchedCount) {
          return res.status(404).send({ message: "Application not found" });
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
    });
    //  Job Application Api
    app.post("/applications", async (req, res) => {
      const application = req.body;
      const result = await applicationsCollection.insertOne(application);
      res.send(result);
    });
    app.get("/applications", async (req, res) => {
      const email = req.query.email;

      if (!email) {
        return res.status(400).send({
          message: "Email is required",
        });
      }

      const applications = await applicationsCollection
        .find({ applicantEmail: email })
        .sort({ appliedAt: -1 })
        .toArray();

      res.send(applications);
    });

    return client;
  } catch (err) {
    console.dir(err);
  }
}
connectToMongoDB();

app.get("/", (req, res) => {
  res.send("Welcome to Job Seeker BD Server");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
