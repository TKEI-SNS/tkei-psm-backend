// ============================================================================
// Microsoft Authentication & Dynamic SharePoint File Finder
// ============================================================================

const axios = require('axios');

class MicrosoftAuthService {
  constructor() {
    // SharePoint folder configuration
    this.siteUrl = 'tke.sharepoint.com';
    this.sitePath = '/teams/PSM-MFG68';
    this.folderPath = '/teams/PSM-MFG68/Shared Documents/General/SAP DATA';
    
    // File search patterns
    this.infoRecordPattern = /Info Record Report \d{2}\.\d{2}\.\d{4}/i;
    this.porvPattern = /PORV .+ to .+\.xlsx$/i;
  }

  /**
   * Get Microsoft Graph API access token
   * This will be called from frontend with user credentials
   */
  async getAccessToken(username, password) {
    // Note: Direct username/password flow (ROPC) is legacy
    // Microsoft recommends interactive auth flow
    // This is here for reference but should use MSAL.js in frontend
    
    throw new Error('Please use MSAL.js interactive authentication in frontend');
  }

  /**
   * List files in SharePoint folder
   */
  async listFilesInFolder(accessToken) {
    try {
      // Get site ID
      const siteResponse = await axios.get(
        `https://graph.microsoft.com/v1.0/sites/${this.siteUrl}:${this.sitePath}`,
        {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        }
      );
      
      const siteId = siteResponse.data.id;
      
      // Get drive ID (Shared Documents)
      const driveResponse = await axios.get(
        `https://graph.microsoft.com/v1.0/sites/${siteId}/drives`,
        {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        }
      );
      
      const sharedDocsDrive = driveResponse.data.value.find(
        d => d.name === 'Documents' || d.name === 'Shared Documents'
      );
      
      if (!sharedDocsDrive) {
        throw new Error('Shared Documents drive not found');
      }
      
      // List files in SAP DATA folder
      const filesResponse = await axios.get(
        `https://graph.microsoft.com/v1.0/drives/${sharedDocsDrive.id}/root:/General/SAP DATA:/children`,
        {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        }
      );
      
      return filesResponse.data.value;
      
    } catch (error) {
      console.error('List files error:', error.response?.data || error.message);
      throw new Error(`Failed to list SharePoint files: ${error.message}`);
    }
  }

  /**
   * Find latest Info Record file by date in filename
   */
  findLatestInfoRecordFile(files) {
    const infoRecordFiles = files.filter(f => 
      this.infoRecordPattern.test(f.name) && f.name.endsWith('.xlsx')
    );
    
    if (infoRecordFiles.length === 0) {
      throw new Error('No Info Record Report files found in folder');
    }
    
    // Extract dates and sort
    const filesWithDates = infoRecordFiles.map(file => {
      const match = file.name.match(/(\d{2})\.(\d{2})\.(\d{4})/);
      if (match) {
        const day = match[1];
        const month = match[2];
        const year = match[3];
        const date = new Date(`${year}-${month}-${day}`);
        return { file, date };
      }
      return null;
    }).filter(Boolean);
    
    if (filesWithDates.length === 0) {
      throw new Error('No valid dates found in Info Record filenames');
    }
    
    // Sort by date descending (latest first)
    filesWithDates.sort((a, b) => b.date - a.date);
    
    const latestFile = filesWithDates[0].file;
    
    return {
      fileName: latestFile.name,
      fileId: latestFile.id,
      downloadUrl: latestFile['@microsoft.graph.downloadUrl'],
      lastModified: latestFile.lastModifiedDateTime,
      size: latestFile.size,
      extractedDate: filesWithDates[0].date.toISOString().split('T')[0]
    };
  }

  /**
   * Find PORV file (only one should exist)
   */
  findPorvFile(files) {
    const porvFiles = files.filter(f => 
      this.porvPattern.test(f.name)
    );
    
    if (porvFiles.length === 0) {
      throw new Error('No PORV file found in folder');
    }
    
    if (porvFiles.length > 1) {
      console.warn(`Multiple PORV files found (${porvFiles.length}), using first one`);
    }
    
    const porvFile = porvFiles[0];
    
    return {
      fileName: porvFile.name,
      fileId: porvFile.id,
      downloadUrl: porvFile['@microsoft.graph.downloadUrl'],
      lastModified: porvFile.lastModifiedDateTime,
      size: porvFile.size
    };
  }

  /**
   * Download file from SharePoint using Graph API
   */
  async downloadFile(downloadUrl, accessToken) {
    try {
      const response = await axios.get(downloadUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        responseType: 'arraybuffer'
      });
      
      return response.data;
      
    } catch (error) {
      throw new Error(`Failed to download file: ${error.message}`);
    }
  }

  /**
   * Complete workflow: Find and download latest files
   */
  async findAndDownloadLatestFiles(accessToken) {
    try {
      // 1. List all files in folder
      const files = await this.listFilesInFolder(accessToken);
      
      console.log(`Found ${files.length} files in SAP DATA folder`);
      
      // 2. Find latest Info Record file
      const infoRecordFile = this.findLatestInfoRecordFile(files);
      console.log(`Latest Info Record: ${infoRecordFile.fileName}`);
      
      // 3. Find PORV file
      const porvFile = this.findPorvFile(files);
      console.log(`PORV file: ${porvFile.fileName}`);
      
      // 4. Download both files
      const infoRecordData = await this.downloadFile(
        infoRecordFile.downloadUrl,
        accessToken
      );
      
      const porvData = await this.downloadFile(
        porvFile.downloadUrl,
        accessToken
      );
      
      return {
        success: true,
        infoRecord: {
          ...infoRecordFile,
          data: infoRecordData
        },
        porv: {
          ...porvFile,
          data: porvData
        }
      };
      
    } catch (error) {
      console.error('Find and download error:', error);
      throw error;
    }
  }
}

module.exports = MicrosoftAuthService;
