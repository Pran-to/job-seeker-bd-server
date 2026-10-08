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
    app.get("/jobs", async (req, res) => {
      const query = {};
      const cursor = jobsCollection.find(query);
      const jobs = await cursor.toArray();
      res.send(jobs);
    });
    app.get("/jobs/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const job = await jobsCollection.findOne(query);
      res.send(job);
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
