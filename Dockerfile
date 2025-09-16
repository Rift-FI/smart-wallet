# Use official Node.js 18 image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies (all are now in dependencies)
RUN npm install --force

# Copy the rest of the source code
COPY . .




# Expose port if your app listens (adjust if needed)
EXPOSE 8081

# Run the app
CMD ["npm", "run", "dev"]