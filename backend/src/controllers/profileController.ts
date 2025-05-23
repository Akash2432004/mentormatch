import { Request, Response } from 'express';
import { pool } from '../db/index.js';
import { AuthRequest } from '../middleware/auth.js';
import multer, { FileFilterCallback } from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';

// Extend AuthRequest to include file from multer
interface AuthRequestWithFile extends AuthRequest {
  file?: Express.Multer.File;
}

// Configure multer for file upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, './uploads/profile-photos/');
  },
  filename: (req, file, cb) => {
    const uniqueFilename = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueFilename);
  }
});

const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG and GIF are allowed.'));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
}).single('photo');

const API_URL = process.env.API_URL || 'http://localhost:3000';

export const profileController = {
  async getProfile(req: AuthRequest, res: Response) {
    const userId = req.user?.uid;
    
    try {
      const client = await pool.connect();
      
      try {
        // Get complete profile data with user information
        const result = await client.query(
          `SELECT 
            u.id,
            u.email,
            u.display_name,
            u.photo_url,
            u.custom_user_id,
            up.major,
            up.interests,
            up.completed_assessments,
            up.assessment_results
           FROM users u
           LEFT JOIN user_profiles up ON u.id = up.user_id
           WHERE u.id = $1`,
          [userId]
        );

        if (result.rows.length === 0) {
          // If user doesn't exist, create profile
          await client.query('BEGIN');
          
          // Insert user if not exists
          await client.query(
            `INSERT INTO users (id, email, display_name)
             VALUES ($1, $2, $3)
             ON CONFLICT (id) DO NOTHING`,
            [userId, req.user?.email, req.user?.email?.split('@')[0]]
          );

          // Insert profile if not exists
          await client.query(
            `INSERT INTO user_profiles (user_id)
             VALUES ($1)
             ON CONFLICT (user_id) DO NOTHING`,
            [userId]
          );

          // Get the newly created profile
          const newResult = await client.query(
            `SELECT 
              u.id,
              u.email,
              u.display_name,
              u.photo_url,
              u.custom_user_id,
              up.major,
              up.interests,
              up.completed_assessments,
              up.assessment_results
             FROM users u
             LEFT JOIN user_profiles up ON u.id = up.user_id
             WHERE u.id = $1`,
            [userId]
          );

          await client.query('COMMIT');
          return res.json(newResult.rows[0]);
        }
        res.json(result.rows[0]);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('Error fetching profile:', err);
      res.status(500).json({ error: 'Failed to fetch profile' });
    }
  },

  async updateProfile(req: AuthRequest, res: Response) {
    const userId = req.user?.uid;
    const { major, interests, custom_user_id, display_name } = req.body;

    try {
      // Validate display_name
      if (!display_name || display_name.trim().length === 0) {
        return res.status(400).json({ 
          error: 'Display name is required' 
        });
      }

      const client = await pool.connect();
      
      try {
        await client.query('BEGIN');

        // Update users table with display_name
        await client.query(
          `UPDATE users 
           SET custom_user_id = $1, 
               display_name = $2,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [custom_user_id || null, display_name.trim(), userId]
        );

        // Update user_profiles table
        await client.query(
          `UPDATE user_profiles 
           SET major = $1, 
               interests = $2, 
               updated_at = CURRENT_TIMESTAMP
           WHERE user_id = $3`,
          [major || null, interests || [], userId]
        );

        // Get updated profile data
        const result = await client.query(
          `SELECT 
            u.id,
            u.email,
            u.display_name,
            u.photo_url,
            u.custom_user_id,
            up.major,
            up.interests,
            up.completed_assessments,
            up.assessment_results
           FROM users u
           JOIN user_profiles up ON u.id = up.user_id
           WHERE u.id = $1`,
          [userId]
        );

        await client.query('COMMIT');
        res.json(result.rows[0]);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('Error updating profile:', err);
      res.status(500).json({ 
        error: err instanceof Error ? err.message : 'Failed to update profile'
      });
    }
  },

  async updateAssessment(req: AuthRequest, res: Response) {
    const userId = req.user?.uid;
    const { results } = req.body;

    try {
      // First check if profile exists
      const profileCheck = await pool.query(
        'SELECT 1 FROM user_profiles WHERE user_id = $1',
        [userId]
      );

      if (profileCheck.rows.length === 0) {
        // Create profile if it doesn't exist
        const newProfile = await pool.query(
          `INSERT INTO user_profiles 
           (user_id, assessment_results, completed_assessments)
           VALUES ($1, $2::jsonb, 1)
           RETURNING *`,
          [userId, JSON.stringify(results)]
        );
        return res.json(newProfile.rows[0]);
      }

      // Update existing profile
      const result = await pool.query(
        `UPDATE user_profiles 
         SET assessment_results = $1::jsonb, 
             completed_assessments = completed_assessments + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $2
         RETURNING *`,
        [JSON.stringify(results), userId]
      );

      res.json(result.rows[0]);
    } catch (err) {
      console.error('Error updating assessment:', err);
      res.status(500).json({ error: 'Failed to update assessment' });
    }
  },

  async deleteAssessmentResults(req: AuthRequest, res: Response) {
    const userId = req.user?.uid;
    const { dates } = req.body;

    try {
      const result = await pool.query(
        `UPDATE user_profiles 
         SET assessment_results = (
           SELECT jsonb_agg(result)
           FROM jsonb_array_elements(assessment_results) result
           WHERE result->>'date' != ANY($1)
         ),
         completed_assessments = completed_assessments - $2,
         updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $3
         RETURNING *`,
        [dates, dates.length, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Profile not found' });
      }

      res.json(result.rows[0]);
    } catch (err) {
      console.error('Error deleting assessment results:', err);
      throw err;
    }
  },

  async updateCustomId(req: AuthRequest, res: Response) {
    const userId = req.user?.uid;
    const { custom_user_id } = req.body;

    try {
      // Check if custom_user_id is already taken
      const existingUser = await pool.query(
        'SELECT id FROM users WHERE custom_user_id = $1 AND id != $2',
        [custom_user_id, userId]
      );

      if (existingUser.rows.length > 0) {
        return res.status(400).json({ error: 'This user ID is already taken' });
      }

      // Update user
      const result = await pool.query(
        `UPDATE users 
         SET custom_user_id = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING *`,
        [custom_user_id, userId]
      );

      res.json(result.rows[0]);
    } catch (err) {
      console.error('Error updating custom user ID:', err);
      res.status(500).json({ 
        error: 'Failed to update user ID',
        details: process.env.NODE_ENV === 'development' 
          ? (err instanceof Error ? err.message : String(err))
          : undefined
      });
    }
  },

  async checkCustomId(req: AuthRequest, res: Response) {
    const userId = req.user?.uid;
    const { custom_user_id } = req.query;

    try {
      if (!custom_user_id) {
        return res.json({ available: true });
      }

      const result = await pool.query(
        'SELECT id FROM users WHERE custom_user_id = $1 AND id != $2',
        [custom_user_id, userId]
      );

      res.json({ available: result.rows.length === 0 });
    } catch (err) {
      console.error('Error checking custom ID:', err);
      res.status(500).json({ error: 'Failed to check custom ID availability' });
    }
  },

  async updateProfilePhoto(req: AuthRequestWithFile, res: Response) {
    const userId = req.user?.uid;
    
    // Ensure uploads directory exists
    const uploadsDir = path.join(process.cwd(), 'uploads', 'profile-photos');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    upload(req, res, async (err) => {
      if (err) {
        console.error('Upload error:', err);
        return res.status(400).json({ error: err.message });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      try {
        const photoUrl = `/uploads/profile-photos/${req.file.filename}`;
        console.log('File saved at:', path.join(process.cwd(), photoUrl));
        
        await pool.query(
          'UPDATE users SET photo_url = $1 WHERE id = $2 RETURNING photo_url',
          [photoUrl, userId]
        );

        res.json({ photo_url: photoUrl });
      } catch (error) {
        console.error('Error updating profile photo:', error);
        res.status(500).json({ error: 'Failed to update profile photo' });
      }
    });
  },

  async deleteUser(req: AuthRequest, res: Response) {
    const userId = req.user?.uid;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Get user's profile photo URL before deletion
      const userResult = await client.query(
        'SELECT photo_url FROM users WHERE id = $1',
        [userId]
      );
      
      const photoUrl = userResult.rows[0]?.photo_url;
      
      // Delete user's profile first
      await client.query('DELETE FROM user_profiles WHERE user_id = $1', [userId]);
      
      // Then delete the user
      await client.query('DELETE FROM users WHERE id = $1', [userId]);

      await client.query('COMMIT');

      // If there was a profile photo, you might want to delete it from the filesystem
      if (photoUrl) {
        try {
          const photoPath = path.join(process.cwd(), photoUrl);
          await fs.promises.unlink(photoPath);
        } catch (photoErr) {
          console.error('Failed to delete profile photo:', photoErr);
          // Don't throw error as the user deletion was successful
        }
      }

      res.status(200).json({ message: 'User deleted successfully' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error deleting user:', err);
      res.status(500).json({ 
        error: err instanceof Error ? err.message : 'Failed to delete user' 
      });
    } finally {
      client.release();
    }
  },

  async checkUsername(req: AuthRequest, res: Response) {
    const { username } = req.params;
    const userId = req.user?.uid;

    try {
      // Validate username format
      if (!/^[a-zA-Z0-9_]{1,30}$/.test(username)) {
        return res.status(400).json({ 
          available: false,
          error: 'Invalid username format' 
        });
      }

      const client = await pool.connect();
      try {
        const result = await client.query(
          'SELECT id FROM users WHERE custom_user_id = $1 AND id != $2',
          [username, userId]
        );
        
        res.json({ available: result.rows.length === 0 });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error checking username:', error);
      res.status(500).json({ error: 'Failed to check username availability' });
    }
  }
}; 
