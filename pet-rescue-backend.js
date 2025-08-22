// Pet Rescue Backend API
// Node.js/Express server with web scraping capabilities

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const cheerio = require('cheerio');
const { Pool } = require('pg');
require('dotenv').config();

// ---------------------------------------------------------------- //
// Core Application Setup
// ---------------------------------------------------------------- //

const app = express();
const PORT = process.env.PORT || 3001;

// Database connection (Railway Postgres)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    require: true,
    rejectUnauthorized: false, // Required for Railway
  },
});

// Middleware
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------- //
// Database Functions
// ---------------------------------------------------------------- //

const initDatabase = async () => {
  const createTablesQuery = `
    CREATE TABLE IF NOT EXISTS pets (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      species VARCHAR(50) NOT NULL,
      breed VARCHAR(255),
      age VARCHAR(50),
      location VARCHAR(500),
      state VARCHAR(2),
      days_in_shelter INTEGER,
      days_until_euthanasia INTEGER,
      urgency_level VARCHAR(20),
      description TEXT,
      contact_phone VARCHAR(50),
      contact_email VARCHAR(255),
      source_name VARCHAR(255),
      source_url TEXT,
      image_url TEXT,
      posted_date DATE,
      scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      is_active BOOLEAN DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS alert_subscriptions (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      states JSONB,
      species JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_pets_state ON pets(state);
    CREATE INDEX IF NOT EXISTS idx_pets_species ON pets(species);
    CREATE INDEX IF NOT EXISTS idx_pets_urgency ON pets(urgency_level);
    CREATE INDEX IF NOT EXISTS idx_pets_days_until ON pets(days_until_euthanasia);
    CREATE INDEX IF NOT EXISTS idx_pets_active ON pets(is_active);
  `;

  try {
    await pool.query(createTablesQuery);
    console.log('Database tables initialized');
  } catch (error) {
    console.error('Error initializing database:', error);
  }
};

// Save pet to database
const savePetToDB = async (pet) => {
  const query = `
    INSERT INTO pets (
      name, species, breed, age, location, state, days_in_shelter,
      days_until_euthanasia, urgency_level, description, contact_phone,
      contact_email, source_name, source_url, image_url, posted_date
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    ON CONFLICT DO NOTHING
    RETURNING id
  `;

  const values = [
    pet.name, pet.species, pet.breed, pet.age, pet.location, pet.state,
    pet.days_in_shelter, pet.days_until_euthanasia, pet.urgency_level,
    pet.description, pet.contact_phone, pet.contact_email, pet.source_name,
    pet.source_url, pet.image_url, pet.posted_date
  ];

  try {
    const result = await pool.query(query, values);
    return result.rows[0]?.id;
  } catch (error) {
    console.error('Error saving pet to database:', error);
    return null;
  }
};

// ---------------------------------------------------------------- //
// Scrapers (simplified version)
class PetfinderScraper {
  constructor() {
    this.baseUrl = 'https://www.petfinder.com';
  }
  async scrapePets(location, species = 'all') {
    // simplified scraping for demonstration
    return [];
  }
}

class AdoptAPetScraper {
  constructor() {
    this.baseUrl = 'https://www.adopt-a-pet.com';
  }
  async scrapePets(location, species = 'all') {
    // simplified scraping for demonstration
    return [];
  }
}

// ---------------------------------------------------------------- //
// Utilities
// ---------------------------------------------------------------- //

class UrgencyCalculator {
  static calculateUrgency(pet) {
    if (pet.days_until_euthanasia <= 3) return 'critical';
    if (pet.days_until_euthanasia <= 7) return 'moderate';
    if (pet.days_in_shelter > 30) return 'moderate';
    return 'low';
  }
}

const extractStateFromLocation = (location) => {
  if (!location) return null;
  const stateMatch = location.match(/,\s*([A-Z]{2})/);
  return stateMatch ? stateMatch[1] : null;
};

const processScrapedPets = async (scrapedPets) => {
  for (const pet of scrapedPets) {
    pet.state = extractStateFromLocation(pet.location);
    pet.urgency_level = UrgencyCalculator.calculateUrgency(pet);
    pet.posted_date = pet.posted_date || new Date();
    await savePetToDB(pet);
  }
};

// ---------------------------------------------------------------- //
// Seed Sample Pets (for testing / first load)
const seedSamplePets = async () => {
  const result = await pool.query('SELECT COUNT(*) FROM pets');
  if (parseInt(result.rows[0].count) === 0) {
    console.log('Seeding sample pets...');
    const samplePets = [
      {
        name: 'Buddy',
        species: 'Dog',
        breed: 'Labrador',
        age: '2 years',
        location: 'Dallas, TX',
        days_in_shelter: 10,
        days_until_euthanasia: 5,
        description: 'Friendly and energetic dog.',
        contact_phone: '123-456-7890',
        contact_email: 'buddy@example.com',
        source_name: 'Sample',
        source_url: '',
        image_url: 'https://placekitten.com/400/300'
      },
      {
        name: 'Whiskers',
        species: 'Cat',
        breed: 'Siamese',
        age: '3 years',
        location: 'Miami, FL',
        days_in_shelter: 20,
        days_until_euthanasia: 2,
        description: 'Playful and affectionate cat.',
        contact_phone: '987-654-3210',
        contact_email: 'whiskers@example.com',
        source_name: 'Sample',
        source_url: '',
        image_url: 'https://placekitten.com/401/301'
      }
    ];

    await processScrapedPets(samplePets);
  }
};

// ---------------------------------------------------------------- //
// API Routes
// ---------------------------------------------------------------- //

app.get('/api/pets', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM pets WHERE is_active = true ORDER BY scraped_at DESC LIMIT 50');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching pets:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------- //
// Server Initialization
// ---------------------------------------------------------------- //

const startServer = async () => {
  try {
    await initDatabase();
    await seedSamplePets();

    app.listen(PORT, () => {
      console.log(`Server is listening on port ${PORT}`);
    });

    // Schedule daily scraping at 2 AM
    cron.schedule('0 2 * * *', async () => {
      console.log('Running scheduled scraping job...');
      try {
        const locations = ['New York, NY', 'Los Angeles, CA', 'Miami, FL', 'Dallas, TX'];
        const speciesList = ['dog', 'cat'];

        for (const location of locations) {
          for (const species of speciesList) {
            const petfinderScraper = new PetfinderScraper();
            const adoptAPetScraper = new AdoptAPetScraper();
            const [petfinderPets, adoptAPetPets] = await Promise.all([
              petfinderScraper.scrapePets(location, species),
              adoptAPetScraper.scrapePets(location, species)
            ]);

            const allPets = [...petfinderPets, ...adoptAPetPets];
            await processScrapedPets(allPets);
            console.log(`Scraped ${allPets.length} pets from ${location} (${species})`);
          }
        }
        console.log('Scheduled scraping job completed.');
      } catch (error) {
        console.error('Error in scheduled scraping job:', error);
      }
    });

  } catch (error) {
    console.error('Error starting server:', error);
  }
};

startServer();
