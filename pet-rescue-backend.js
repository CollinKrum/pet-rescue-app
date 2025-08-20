// Pet Rescue Backend API
// This is a Node.js/Express server with web scraping capabilities

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const cheerio = require('cheerio');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Middleware
app.use(cors());
app.use(express.json());

// Database schema - run this to create tables
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

// Pet scraper classes for different sources
class PetfinderScraper {
  constructor() {
    this.baseUrl = 'https://www.petfinder.com';
    this.searchUrl = 'https://www.petfinder.com/search/pets-for-adoption';
  }

  async scrapePets(location, species = 'all') {
    try {
      const response = await axios.get(`${this.searchUrl}/?location=${location}&type=${species}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      const $ = cheerio.load(response.data);
      const pets = [];

      $('.petCard').each((index, element) => {
        const $pet = $(element);
        
        const pet = {
          name: $pet.find('.petCard-name').text().trim(),
          breed: $pet.find('.petCard-breed').text().trim(),
          age: $pet.find('.petCard-age').text().trim(),
          location: $pet.find('.petCard-location').text().trim(),
          image_url: $pet.find('.petCard-photo img').attr('src'),
          source_url: this.baseUrl + $pet.find('a').attr('href'),
          source_name: 'Petfinder',
          species: species === 'dog' ? 'Dog' : species === 'cat' ? 'Cat' : 'Unknown'
        };

        if (pet.name) {
          pets.push(pet);
        }
      });

      return pets;
    } catch (error) {
      console.error('Error scraping Petfinder:', error);
      return [];
    }
  }
}

class AdoptAPetScraper {
  constructor() {
    this.baseUrl = 'https://www.adopt-a-pet.com';
  }

  async scrapePets(location, species = 'all') {
    try {
      const searchUrl = `${this.baseUrl}/search?location=${location}&animal=${species}`;
      const response = await axios.get(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      const $ = cheerio.load(response.data);
      const pets = [];

      $('.pet-card').each((index, element) => {
        const $pet = $(element);
        
        const pet = {
          name: $pet.find('.pet-name').text().trim(),
          breed: $pet.find('.pet-breed').text().trim(),
          age: $pet.find('.pet-age').text().trim(),
          location: $pet.find('.pet-location').text().trim(),
          image_url: $pet.find('.pet-photo img').attr('src'),
          source_url: this.baseUrl + $pet.find('a').attr('href'),
          source_name: 'Adopt-a-Pet',
          species: this.determineSpecies($pet.find('.pet-type').text())
        };

        if (pet.name) {
          pets.push(pet);
        }
      });

      return pets;
    } catch (error) {
      console.error('Error scraping Adopt-a-Pet:', error);
      return [];
    }
  }

  determineSpecies(typeText) {
    const text = typeText.toLowerCase();
    if (text.includes('dog')) return 'Dog';
    if (text.includes('cat')) return 'Cat';
    return 'Unknown';
  }
}

class FacebookGroupScraper {
  // Note: Facebook scraping is complex due to authentication and anti-bot measures
  // This is a conceptual implementation - you'd need Facebook Graph API access
  
  constructor() {
    this.accessToken = process.env.FACEBOOK_ACCESS_TOKEN;
  }

  async scrapePosts(groupId) {
    try {
      // This would require Facebook Graph API
      const response = await axios.get(
        `https://graph.facebook.com/v18.0/${groupId}/feed`,
        {
          params: {
            access_token: this.accessToken,
            fields: 'message,created_time,attachments'
          }
        }
      );

      const posts = response.data.data;
      const pets = [];

      posts.forEach(post => {
        if (this.isPetPost(post.message)) {
          const pet = this.extractPetInfo(post);
          if (pet) pets.push(pet);
        }
      });

      return pets;
    } catch (error) {
      console.error('Error scraping Facebook:', error);
      return [];
    }
  }

  isPetPost(message) {
    if (!message) return false;
    const keywords = ['adopt', 'rescue', 'shelter', 'euthanize', 'urgent', 'foster'];
    return keywords.some(keyword => message.toLowerCase().includes(keyword));
  }

  extractPetInfo(post) {
    // Extract pet information from Facebook post using NLP/regex
    // This is a simplified version - you'd want more sophisticated parsing
    const message = post.message || '';
    
    return {
      name: this.extractName(message),
      description: message.substring(0, 200),
      source_name: 'Facebook Group',
      source_url: `https://facebook.com/${post.id}`,
      posted_date: new Date(post.created_time)
    };
  }

  extractName(message) {
    // Simple name extraction - you'd want better NLP
    const nameMatch = message.match(/name[:\s]*([A-Z][a-z]+)/i);
    return nameMatch ? nameMatch[1] : 'Unknown';
  }
}

// Urgency calculator
class UrgencyCalculator {
  static calculateUrgency(pet) {
    if (pet.days_until_euthanasia <= 3) return 'critical';
    if (pet.days_until_euthanasia <= 7) return 'moderate';
    if (pet.days_in_shelter > 30) return 'moderate';
    return 'low';
  }
}

// Data processing functions
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

const processScrapedPets = async (scrapedPets) => {
  for (const pet of scrapedPets) {
    // Extract state from location
    pet.state = extractStateFromLocation(pet.location);
    
    // Calculate urgency
    pet.urgency_level = UrgencyCalculator.calculateUrgency(pet);
    
    // Set default posted date if not provided
    pet.posted_date = pet.posted_date || new Date();
    
    await savePetToDB(pet);
  }
};

const extractStateFromLocation = (location) => {
  if (!location) return null;
  
  // Simple state extraction - you might want a more robust solution
  const stateMatch = location.match(/,\s*([A-Z]{2})/);
  return stateMatch ? stateMatch[1] : null;
};

// API Routes
app.get('/api/pets', async (req, res) => {
  try {
    const {
      state,
      species,
      urgency_level,
      days_in_shelter_min,
      days_in_shelter_max,
      days_until_euthanasia_max,
      limit = 50,
      offset = 0
    } = req.query;

    let query = 'SELECT * FROM pets WHERE is_active = true';
    const params = [];
    let paramCount = 0;

    if (state) {
      query += ` AND state = $${++paramCount}`;
      params.push(state);
    }

    if (species) {
      query += ` AND species = $${++paramCount}`;
      params.push(species);
    }

    if (urgency_level) {
      query += ` AND urgency_level = $${++paramCount}`;
      params.push(urgency_level);
    }

    if (days_in_shelter_min) {
      query += ` AND days_in_shelter >= $${++paramCount}`;
      params.push(parseInt(days_in_shelter_min));
    }

    if (days_in_shelter_max) {
      query += ` AND days_in_shelter <= $${++paramCount}`;
      params.push(parseInt(days_in_shelter_max));
    }

    if (days_until_euthanasia_max) {
      query += ` AND days_until_euthanasia <= $${++paramCount}`;
      params.push(parseInt(days_until_euthanasia_max));
    }

    query += ` ORDER BY 
      CASE urgency_level 
        WHEN 'critical' THEN 1 
        WHEN 'moderate' THEN 2 
        WHEN 'low' THEN 3 
      END,
      days_until_euthanasia ASC,
      scraped_at DESC
      LIMIT $${++paramCount} OFFSET $${++paramCount}`;
    
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching pets:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/pets/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM pets WHERE id = $1 AND is_active = true', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pet not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching pet:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Complete stats endpoint
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_pets,
        COUNT(*) FILTER (WHERE urgency_level = 'critical') as critical_pets,
        COUNT(*) FILTER (WHERE urgency_level = 'moderate') as moderate_pets,
        COUNT(*) FILTER (WHERE urgency_level = 'low') as low_pets,
        COUNT(*) FILTER (WHERE species = 'Dog') as dogs,
        COUNT(*) FILTER (WHERE species = 'Cat') as cats,
        COUNT(DISTINCT state) as states_covered,
        AVG(days_in_shelter) as avg_days_in_shelter
      FROM pets 
      WHERE is_active = true
    `);

    res.json(stats.rows[0]);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Manual scraping trigger (for admin)
app.post('/api/admin/scrape', async (req, res) => {
  try {
    const { location, species } = req.body;
    
    // Run scrapers
    const petfinderScraper = new PetfinderScraper();
    const adoptAPetScraper = new AdoptAPetScraper();
    
    const [petfinderPets, adoptAPetPets] = await Promise.all([
      petfinderScraper.scrapePets(location, species),
      adoptAPetScraper.scrapePets(location, species)
    ]);
    
    const allPets = [...petfinderPets, ...adoptAPetPets];
    await processScrapedPets(allPets);
    
    res.json({ 
      message: 'Scraping completed', 
      petsProcessed: allPets.length 
    });
  } catch (error) {
    console.error('Error in manual scraping:', error);
    res.status(500).json({ error: 'Scraping failed' });
  }
});

// Email alerts for critical cases
app.post('/api/alerts/subscribe', async (req, res) => {
  try {
    const { email, states, species } = req.body;
    
    // Store subscription in database
    await pool.query(`
      INSERT INTO alert_subscriptions (email, states, species, created_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (email) DO UPDATE SET
        states = $2, species = $3, updated_at = NOW()
    `, [email, JSON.stringify(states), JSON.stringify(species)]);
    
    res.json({ message: 'Subscription saved' });
  } catch (error) {
    console.error('Error saving subscription:', error);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

// Webhook for external integrations
app.post('/api/webhook/new-pet', async (req, res) => {
  try {
    const petData = req.body;
    
    // Validate and process incoming pet data
    petData.urgency_level = UrgencyCalculator.calculateUrgency(petData);
    petData.state = extractStateFromLocation(petData.location);
    
    const petId = await savePetToDB(petData);
    
    // Trigger alerts for critical cases
    if (petData.urgency_level === 'critical') {
      await sendCriticalAlerts(petData);
    }
    
    res.json({ message: 'Pet added successfully', id: petId });
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0'
  });
});

// Function to send critical alerts
const sendCriticalAlerts = async (pet) => {
  try {
    const subscribers = await pool.query(`
      SELECT email FROM alert_subscriptions 
      WHERE (states IS NULL OR states::jsonb ? $1)
      AND (species IS NULL OR species::jsonb ? $2)
    `, [pet.state, pet.species]);
    
    // Here you would integrate with an email service like SendGrid or Mailgun
    console.log(`Would send alerts to ${subscribers.rows.length} subscribers for ${pet.name}`);
  } catch (error) {
    console.error('Error sending alerts:', error);
  }
};

// Add table for subscriptions
const createSubscriptionsTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alert_subscriptions (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      states JSONB,
      species JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
};
