const { LocalIndex } = require('vectra');
const OpenAI = require('openai');
const fs = require('fs').promises;
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

class RequirementsSearchEngine {
  constructor(indexPath = './requirements-index', openaiApiKey) {
    this.indexPath = indexPath;
    this.index = new LocalIndex(indexPath);
    this.openai = new OpenAI({ apiKey: openaiApiKey });
    this.isInitialized = false;
  }

  async initialize() {
    if (!this.isInitialized) {
      try {
        await this.index.createIndex();
        this.isInitialized = true;
      } catch (error) {
        // Index might already exist, try to use it
        if (error.message.includes('already exists')) {
          this.isInitialized = true;
        } else {
          throw error;
        }
      }
    }
  }

  // Split text into chunks for better searchability
  splitIntoChunks(text, chunkSize = 500, overlap = 50) {
    const words = text.split(/\s+/);
    const chunks = [];
    
    for (let i = 0; i < words.length; i += chunkSize - overlap) {
      const chunk = words.slice(i, i + chunkSize).join(' ');
      if (chunk.trim().length > 0) {
        chunks.push({
          text: chunk.trim(),
          startIndex: i,
          wordCount: Math.min(chunkSize, words.length - i)
        });
      }
    }
    
    return chunks;
  }

  // Extract text from Excel files with proper sheet and row tracking
  async extractTextFromExcel(filePath) {
    const workbook = XLSX.readFile(filePath);
    const results = [];
    
    workbook.SheetNames.forEach(sheetName => {
      const worksheet = workbook.Sheets[sheetName];
      const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1:A1');
      
      for (let row = range.s.r; row <= range.e.r; row++) {
        const rowData = [];
        for (let col = range.s.c; col <= range.e.c; col++) {
          const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
          const cell = worksheet[cellAddress];
          if (cell && cell.v) {
            rowData.push(String(cell.v));
          }
        }
        
        if (rowData.length > 0) {
          const text = rowData.join(' | ');
          results.push({
            text,
            sheet: sheetName,
            row: row + 1,
            rowRange: `${row + 1}:${row + 1}`
          });
        }
      }
    });
    
    return results;
  }

  // Extract text from different file formats
  async extractTextFromFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath);
    
    try {
      switch (ext) {
        case '.pdf':
          const pdfBuffer = await fs.readFile(filePath);
          const pdfData = await pdfParse(pdfBuffer);
          return [{ text: pdfData.text, fileName, type: 'pdf' }];
          
        case '.docx':
          const docxBuffer = await fs.readFile(filePath);
          const result = await mammoth.extractRawText({ buffer: docxBuffer });
          return [{ text: result.value, fileName, type: 'docx' }];
          
        case '.xlsx':
        case '.xls':
          const excelData = await this.extractTextFromExcel(filePath);
          return excelData.map(item => ({
            ...item,
            fileName,
            type: 'excel'
          }));
          
        case '.txt':
        case '.md':
          const textContent = await fs.readFile(filePath, 'utf-8');
          return [{ text: textContent, fileName, type: 'text' }];
          
        default:
          throw new Error(`Unsupported file format: ${ext}`);
      }
    } catch (error) {
      console.error(`Error processing file ${filePath}:`, error);
      throw error;
    }
  }

  // Generate embeddings using OpenAI
  async generateEmbedding(text) {
    try {
      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
        encoding_format: 'float'
      });
      
      return response.data[0].embedding;
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw error;
    }
  }

  // Index a single document
  async indexDocument(filePath) {
    await this.initialize();
    
    const extractedData = await this.extractTextFromFile(filePath);
    let totalChunks = 0;
    
    for (const data of extractedData) {
      const chunks = this.splitIntoChunks(data.text);
      
      // Process chunks in batches to avoid rate limits
      const batchSize = 5;
      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        
        await Promise.all(batch.map(async (chunk, batchIndex) => {
          const embedding = await this.generateEmbedding(chunk.text);
          
          const chunkId = data.sheet 
            ? `${data.fileName}_${data.sheet}_row${data.row}_chunk${i + batchIndex}`
            : `${data.fileName}_chunk_${i + batchIndex}`;
            
          await this.index.insertItem({
            id: chunkId,
            vector: embedding,
            metadata: {
              fileName: data.fileName,
              filePath,
              chunkIndex: i + batchIndex,
              text: chunk.text,
              wordCount: chunk.wordCount,
              preview: chunk.text.substring(0, 150) + '...',
              type: data.type,
              sheet: data.sheet || null,
              row: data.row || null,
              rowRange: data.rowRange || null
            }
          });
        }));
        
        // Small delay to respect API rate limits
        if (i + batchSize < chunks.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      totalChunks += chunks.length;
    }
    
    return { fileName: path.basename(filePath), chunksCreated: totalChunks };
  }

  // Search documents using natural language
  async search(query, topK = 5) {
    await this.initialize();
    
    // Generate embedding for the search query
    const queryEmbedding = await this.generateEmbedding(query);
    
    // Perform vector similarity search
    const results = await this.index.queryItems(queryEmbedding, topK);
    
    // Format results for better readability
    return results.map(result => ({
      score: result.score,
      fileName: result.item.metadata.fileName,
      text: result.item.metadata.text,
      preview: result.item.metadata.preview,
      chunkIndex: result.item.metadata.chunkIndex,
      relevancePercentage: Math.round(result.score * 100),
      type: result.item.metadata.type,
      sheet: result.item.metadata.sheet,
      row: result.item.metadata.row,
      rowRange: result.item.metadata.rowRange
    }));
  }

  // Get statistics about the indexed documents
  async getStats() {
    await this.initialize();
    
    try {
      const items = await this.index.listItems();
      const fileNames = [...new Set(items.map(item => item.metadata.fileName))];
      
      return {
        totalChunks: items.length,
        totalDocuments: fileNames.length,
        documents: fileNames,
        indexPath: this.indexPath
      };
    } catch (error) {
      // If index doesn't exist or is empty
      return {
        totalChunks: 0,
        totalDocuments: 0,
        documents: [],
        indexPath: this.indexPath
      };
    }
  }

  // Clear the entire index
  async clearIndex() {
    try {
      await this.index.deleteIndex();
      this.isInitialized = false;
    } catch (error) {
      // Index might not exist
      if (!error.message.includes('does not exist')) {
        throw error;
      }
    }
  }

  // Backup index
  async backupIndex(backupPath) {
    const fs = require('fs-extra');
    const timestamp = Date.now();
    
    try {
      await fs.copy(this.indexPath, backupPath);
      return {
        originalPath: this.indexPath,
        backupPath,
        timestamp
      };
    } catch (error) {
      throw new Error(`Backup failed: ${error.message}`);
    }
  }

  // Restore index from backup
  async restoreIndex(backupPath) {
    const fs = require('fs-extra');
    
    try {
      // Clear current index
      await this.clearIndex();
      
      // Copy backup to index location
      await fs.copy(backupPath, this.indexPath);
      
      // Reinitialize
      this.isInitialized = false;
      await this.initialize();
      
      return await this.getStats();
    } catch (error) {
      throw new Error(`Restore failed: ${error.message}`);
    }
  }
}

module.exports = RequirementsSearchEngine;